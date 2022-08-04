/* tslint:disable:max-classes-per-file */

import * as grpc from '@grpc/grpc-js';
import {
  BindingType,
  CargoDeliveryRequest,
  RelaynetError,
  resolveInternetAddress,
} from '@relaycorp/relaynet-core';
import checkIp from 'check-ip';
import pipe from 'it-pipe';
import { PassThrough } from 'stream';
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
   * Initialize a CogRPC client to connect to a server on the Internet.
   *
   * @param address The Awala Internet address of the server
   * @throws {CogRPCError} if the `address` doesn't exist
   */
  public static async initInternet(address: string): Promise<CogRPCClient> {
    const srvAddress = await resolveInternetAddress(address, BindingType.CRC);
    if (!srvAddress) {
      throw new CogRPCError(`Internet address "${address}" doesn't exist`);
    }

    const credentials = grpc.credentials.createSsl();
    return new CogRPCClient(`${srvAddress.host}:${srvAddress.port}`, credentials);
  }

  /**
   * Initialize a CogRPC client to connect to a server on the Local Area Network.
   *
   * @param host Host name (and potentially port) of the gRPC server
   * @throws {CogRPCClient} if `host` is a public IP address or domain name
   *
   * The server may use self-issued TLS certificates.
   */
  public static async initLan(host: string): Promise<CogRPCClient> {
    const { hostname, port } = new URL(`scheme://${host}`);
    const portSanitized = port === '' ? DEFAULT_PORT : parseInt(port, 10);
    const credentials = await createTlsCredentials(hostname, portSanitized);
    return new CogRPCClient(`${hostname}:${portSanitized}`, credentials);
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
    cargoRelay: AsyncIterable<CargoDeliveryRequest>,
  ): AsyncIterable<string> {
    // tslint:disable-next-line:readonly-keyword
    const pendingAckIds: { [key: string]: string } = {};
    const call = (this.grpcClient as unknown as CargoRelayClientMethodSet).deliverCargo(undefined, {
      deadline: makeDeadline(),
    });

    async function* deliverCargo(): AsyncIterable<CargoDelivery> {
      for await (const relay of cargoRelay) {
        const deliveryId = uuid();
        const delivery: CargoDelivery = { id: deliveryId, cargo: relay.cargo };
        yield delivery;
        // tslint:disable-next-line:no-object-mutation
        pendingAckIds[deliveryId] = relay.localId;
      }
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

    let anyCargoSent = false;
    const sink = new PassThrough({ objectMode: true });
    sink.on('data', (data) => {
      anyCargoSent = true;
      call.write(data);
    });
    sink.once('end', () => {
      if (!anyCargoSent) {
        call.end();
      }
    });
    try {
      yield* await pipe(
        deliverCargo,
        { sink: toIterable.sink(sink), source: call },
        collectAcknowledgments,
      );
    } catch (error) {
      throw error instanceof CogRPCError
        ? error
        : new CogRPCError(error as Error, 'Unexpected error while delivering cargo');
    } finally {
      sink.destroy();

      // Work around https://github.com/grpc/grpc-node/issues/1238#issuecomment-901402063
      call.cancel();
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
    const call = (this.grpcClient as unknown as CargoRelayClientMethodSet).collectCargo(metadata, {
      deadline: makeDeadline(),
    });

    async function* processCargo(source: AsyncIterable<CargoDelivery>): AsyncIterable<Buffer> {
      for await (const delivery of source) {
        yield delivery.cargo;
        call.write({ id: delivery.id });
      }
    }

    try {
      yield* await pipe(call, processCargo);
    } catch (error) {
      call.end();
      throw new CogRPCError(error as Error, 'Unexpected error while collecting cargo');
    }
  }
}

async function createTlsCredentials(host: string, port: number): Promise<grpc.ChannelCredentials> {
  const ipInfo = checkIp(host);
  if (!ipInfo.isValid || ipInfo.isPublicIp) {
    // The host name is a domain name or a public IP address
    throw new CogRPCError(`Server is outside the current LAN (${host})`);
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
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const certificateDer: Buffer = tlsSocket.getPeerCertificate().raw;
      tlsSocket.end();
      return resolve(certificateDer);
    });
    tlsSocket.setTimeout(2_000);
    tlsSocket.on('error', reject);
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
