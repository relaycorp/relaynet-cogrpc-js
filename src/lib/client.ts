import { CargoDelivery, RelaynetError } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import pipe from 'it-pipe';
import * as toIterable from 'stream-to-it';
import uuid from 'uuid-random';

import { CargoDeliveryAck, CargoRelayService, GrpcClient } from './grpcService';

const DEADLINE_SECONDS = 2;

export class CogRPCError extends RelaynetError {}

// tslint:disable-next-line:max-classes-per-file
export class CogRPCClient {
  protected readonly grpcClient: InstanceType<typeof GrpcClient>;

  constructor(serverAddress: string, useTls = true) {
    const credentials = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.grpcClient = new GrpcClient(serverAddress, credentials);
  }

  public close(): void {
    this.grpcClient.close();
  }

  public async *deliverCargo(cargoRelay: IterableIterator<CargoDelivery>): AsyncIterable<string> {
    // tslint:disable-next-line:readonly-keyword
    const pendingAckIds: { [key: string]: string } = {};

    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + DEADLINE_SECONDS);
    const call = ((this.grpcClient as unknown) as CargoRelayService).deliverCargo(undefined, {
      deadline,
    });

    try {
      const output = await pipe(
        toIterable.source(call),
        async function*(source: AsyncIterable<CargoDeliveryAck>): AsyncIterable<CargoDeliveryAck> {
          for (const relay of cargoRelay) {
            const deliveryId = uuid();
            call.write({ id: deliveryId, cargo: relay.cargo });
            // tslint:disable-next-line:no-object-mutation
            pendingAckIds[deliveryId] = relay.localId;
          }
          yield* source;
        },
        async (source: AsyncIterable<CargoDeliveryAck>) => {
          // tslint:disable-next-line:readonly-array
          const chunks: string[] = [];
          for await (const chunk of source) {
            const localId = pendingAckIds[chunk.id];
            if (localId === undefined) {
              throw new CogRPCError(
                `Received unknown acknowledgment "${chunk.id}" from the server`,
              );
            }
            // tslint:disable-next-line:no-delete no-object-mutation
            delete pendingAckIds[chunk.id];
            chunks.push(localId);
          }
          if (Object.getOwnPropertyNames(pendingAckIds).length !== 0) {
            throw new CogRPCError('Server did not acknowledge all cargo deliveries');
          }
          return chunks;
        },
      );

      // TODO: Stop consuming the iterator and return it as is
      for (const ack of output) {
        yield ack;
      }
    } finally {
      call.end();
    }
  }
}
