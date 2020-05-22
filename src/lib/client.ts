import { CargoDeliveryRequest, RelaynetError } from '@relaycorp/relaynet-core';
import { get as getEnvVar } from 'env-var';
import * as grpc from 'grpc';
import pipe from 'it-pipe';
import * as toIterable from 'stream-to-it';
import uuid from 'uuid-random';

import {
  CargoDelivery,
  CargoDeliveryAck,
  CargoRelayClient,
  CargoRelayClientMethodSet,
} from './grpcService';

const DEADLINE_SECONDS = 3;

export class CogRPCError extends RelaynetError {}

// tslint:disable-next-line:max-classes-per-file
export class CogRPCClient {
  public static init(_serverUrl: string): CogRPCClient {
    throw new Error('asfdwaxcfas');
  }

  protected readonly grpcClient: InstanceType<typeof CargoRelayClient>;

  protected constructor(serverUrl: string) {
    this.grpcClient = new CargoRelayClient(serverUrl, this.createCredentials(serverUrl));
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

  protected createCredentials(serverUrl: string): grpc.ChannelCredentials {
    const serverUrlParts = new URL(serverUrl);
    const useTls = serverUrlParts.protocol === 'https:';
    const isTlsRequired = getEnvVar('COGRPC_REQUIRE_TLS').default('true').asBool();
    if (!useTls && isTlsRequired) {
      throw new CogRPCError(`Cannot connect to ${serverUrl} because TLS is required`);
    }
    return useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  }
}

function makeDeadline(): Date {
  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + DEADLINE_SECONDS);
  return deadline;
}
