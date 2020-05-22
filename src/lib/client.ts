import { CargoDeliveryRequest, RelaynetError } from '@relaycorp/relaynet-core';
import checkIp from 'check-ip';
import { get as getEnvVar } from 'env-var';
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

const COURIER_GRPC_PORT = 21473;

export class CogRPCError extends RelaynetError {}

// tslint:disable-next-line:max-classes-per-file
export class CogRPCClient {
  public static async init(serverUrl: string): Promise<CogRPCClient> {
    const credentials = await createCredentials(serverUrl);
    return new CogRPCClient(serverUrl, credentials);
  }

  protected readonly grpcClient: InstanceType<typeof CargoRelayClient>;

  protected constructor(serverUrl: string, credentials: grpc.ChannelCredentials) {
    this.grpcClient = new CargoRelayClient(serverUrl, credentials);
  }

  public close(): void {
    this.grpcClient.close();
  }

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
      throw new CogRPCError(error, 'Unexpected error while collecting cargo');
    }
  }
}

async function createCredentials(serverUrl: string): Promise<grpc.ChannelCredentials> {
  const serverUrlParts = new URL(serverUrl);
  const useTls = serverUrlParts.protocol === 'https:';
  const isTlsRequired = getEnvVar('COGRPC_REQUIRE_TLS').default('true').asBool();
  if (!useTls && isTlsRequired) {
    throw new CogRPCError(`Cannot connect to ${serverUrl} because TLS is required`);
  }
  return useTls
    ? createTlsCredentials(serverUrlParts.hostname, serverUrlParts.port)
    : grpc.credentials.createInsecure();
}

async function createTlsCredentials(host: string, port: string): Promise<grpc.ChannelCredentials> {
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
  const portNumber = port === '' ? COURIER_GRPC_PORT : parseInt(port, 10);
  const certificatePem = await retrieveCertificatePem(host, portNumber);
  return grpc.credentials.createSsl(certificatePem);
}

async function retrieveCertificatePem(host: string, port: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const tlsSocket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const certificateDer: Buffer = tlsSocket.getPeerCertificate().raw;
      tlsSocket.end();
      return resolve(derCertificateToPem(certificateDer));
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
