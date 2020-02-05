import { CargoRelay } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import uuid from 'uuid-random';

import { CargoRelayService, GrpcClient } from './grpcService';

const DEADLINE_SECONDS = 2;

export class CogRPCClient {
  protected readonly grpcClient: InstanceType<typeof GrpcClient>;

  constructor(serverAddress: string, useTls = true) {
    const credentials = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.grpcClient = new GrpcClient(serverAddress, credentials);
  }

  public close(): void {
    this.grpcClient.close();
  }

  public *deliverCargo(cargoRelay: IterableIterator<CargoRelay>): IterableIterator<string> {
    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + DEADLINE_SECONDS);
    const call = ((this.grpcClient as unknown) as CargoRelayService).deliverCargo(undefined, {
      deadline,
    });

    for (const relay of cargoRelay) {
      call.write({ id: uuid(), cargo: relay.cargo });
    }

    yield '';
  }
}
