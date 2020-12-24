/* tslint:disable:max-classes-per-file */

import {
  BindingType,
  CargoDeliveryRequest,
  PublicNodeAddress,
  RelaynetError,
  resolvePublicAddress,
} from '@relaycorp/relaynet-core';
import checkIp from 'check-ip';
import * as grpc from 'grpc';
import pipe from 'it-pipe';
import * as toIterable from 'stream-to-it';
import * as tls from 'tls';
import uuid from 'uuid-random';

import {
  CargoDelivery,
  CargoDeliveryAck,
  CargoRelayClient,
  CargoRelayClientMethodSet,
} from './grpcService';

const DEADLINE_SECONDS = 3;

const MAX_INCOMING_MESSAGE_SIZE = 9_437_184; // 9 MiB

const DEFAULT_PORT = 443;

export class CogRPCError extends RelaynetError {}

/**
 * CogRPC client.
 */
export class CogRPCClient {
  /**
   * Initialize a CogRPC client.
   *
   * If the host name in `serverUrl` is a private IPv4/IPv6 address, self-issued certificates will
   * be accepted. Under no other circumstances will self-issued certificates be accepted.
   *
   * TLS is always required.
   *
   * @param serverUrl URL to the gRPC server
   */
  public static async init(serverUrl: string): Promise<CogRPCClient> {
    const serverUrlParts = new URL(serverUrl);
    if (serverUrlParts.protocol !== 'https:') {
      throw new CogRPCError(`Cannot connect to ${serverUrlParts.hostname} without TLS`);
    }
    const address = await resolveAddress(serverUrlParts.host);
    const credentials = await createTlsCredentials(address.host, address.port);
    return new CogRPCClient(`${address.host}:${address.port}`, credentials);
  }

  protected readonly grpcClient: InstanceType<typeof CargoRelayClient>;

  protected constructor(host: string, credentials: grpc.ChannelCredentials) {
    this.grpcClient = new CargoRelayClient(host, credentials, {
      'grpc.max_receive_message_length': MAX_INCOMING_MESSAGE_SIZE,
    });
  }

  /**
   * Close the underlying gRPC connection.
   */
  public close(): void {
    this.grpcClient.close();
  }

  /**
   * Deliver the specified cargo to the current server.
   *
   * @param cargoRelay
   */
  public async *deliverCargo(
    cargoRelay: IterableIterator<CargoDeliveryRequest>,
  ): AsyncIterable<string> {
    // tslint:disable-next-line:readonly-keyword
    const pendingAckIds: { [key: string]: string } = {};
    const call = ((this.grpcClient as unknown) as CargoRelayClientMethodSet).deliverCargo(
      undefined,
      { deadline: makeDeadline() },
    );

    // tslint:disable-next-line:no-let
    let hasCallEnded = false;
    call.on('end', () => (hasCallEnded = true));

    async function* deliverCargo(
      source: AsyncIterable<CargoDeliveryAck>,
    ): AsyncIterable<CargoDeliveryAck> {
      for (const relay of cargoRelay) {
        if (hasCallEnded) {
          break;
        }
        const deliveryId = uuid();
        const delivery: CargoDelivery = { id: deliveryId, cargo: relay.cargo };
        call.write(delivery);
        // tslint:disable-next-line:no-object-mutation
        pendingAckIds[deliveryId] = relay.localId;
      }
      yield* source;
    }

    async function* collectAcknowledgments(
      source: AsyncIterable<CargoDeliveryAck>,
    ): AsyncIterable<string> {
      for await (const chunk of source) {
        const localId = pendingAckIds[chunk.id];
        if (localId === undefined) {
          throw new CogRPCError(`Received unknown acknowledgment "${chunk.id}" from the server`);
        }
        // tslint:disable-next-line:no-delete no-object-mutation
        delete pendingAckIds[chunk.id];
        yield localId;

        if (Object.getOwnPropertyNames(pendingAckIds).length === 0) {
          break;
        }
      }
      if (Object.getOwnPropertyNames(pendingAckIds).length !== 0) {
        throw new CogRPCError('Server did not acknowledge all cargo deliveries');
      }
    }

    try {
      yield* await pipe(toIterable.source(call), deliverCargo, collectAcknowledgments);
    } catch (error) {
      throw error instanceof CogRPCError
        ? error
        : new CogRPCError(error, 'Unexpected error while delivering cargo');
    } finally {
      call.end();
    }
  }

  /**
   * Collect cargo for a given CCA from the current server.
   *
   * @param ccaSerialized
   */
  public async *collectCargo(ccaSerialized: Buffer): AsyncIterable<Buffer> {
    const metadata = new grpc.Metadata();
    metadata.add('Authorization', `Relaynet-CCA ${ccaSerialized.toString('base64')}`);
    const call = ((this.grpcClient as unknown) as CargoRelayClientMethodSet).collectCargo(
      metadata,
      { deadline: makeDeadline() },
    );

    async function* processCargo(source: AsyncIterable<CargoDelivery>): AsyncIterable<Buffer> {
      for await (const delivery of source) {
        yield delivery.cargo;
        call.write({ id: delivery.id });
      }
    }

    try {
      yield* await pipe(toIterable.source(call), processCargo);
    } catch (error) {
      call.end();
      throw new CogRPCError(error, 'Unexpected error while collecting cargo');
    }
  }
}

async function resolveAddress(hostName: string): Promise<PublicNodeAddress> {
  const srvAddress = await resolvePublicAddress(hostName, BindingType.CRC);
  return srvAddress ?? { host: hostName, port: DEFAULT_PORT };
}

async function createTlsCredentials(host: string, port: number): Promise<grpc.ChannelCredentials> {
  const ipInfo = checkIp(host);
  if (!ipInfo.isValid || ipInfo.isPublicIp) {
    // The host name is a domain name or a public IP address, so we should let the usual certificate
    // validation take place.
    return grpc.credentials.createSsl();
  }

  // The host is a private IP address so it's going to have a self-issued certificate. Due to a
  // bug in grpc-node (https://github.com/grpc/grpc-node/issues/663), we can't simply instruct
  // the client to accept self-issued certificates, so we have to download the TLS certificate
  // from the server so we can pass it explicitly to the client.
  const certificateDer = await retrieveCertificateDer(host, port);
  const certificatePem = derCertificateToPem(certificateDer);
  return grpc.credentials.createSsl(certificatePem);
}

async function retrieveCertificateDer(host: string, port: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const tlsSocket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const certificateDer: Buffer = tlsSocket.getPeerCertificate().raw;
      tlsSocket.end();
      return resolve(certificateDer);
    });
  });
}

function derCertificateToPem(derBuffer: Buffer): Buffer {
  const lines = derBuffer.toString('base64').match(/.{1,64}/g) as RegExpMatchArray;
  const pemString = [`-----BEGIN CERTIFICATE-----`, ...lines, `-----END CERTIFICATE-----`].join(
    '\n',
  );
  return Buffer.from(pemString);
}

function makeDeadline(): Date {
  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + DEADLINE_SECONDS);
  return deadline;
}
