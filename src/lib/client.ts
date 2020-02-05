import { CargoRelayClient } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';

import { GrpcClient } from './grpcService';

export class CogRPCClient implements CargoRelayClient {
  protected grpcClient: grpc.Client;

  constructor(serverAddress: string, useTls = true) {
    const credentials = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.grpcClient = new GrpcClient(serverAddress, credentials);
  }

  public close(): void {}

  public collectCargo(): Buffer[] {
    // @ts-ignore
    return;
  }

  public async *deliverCargo(_cargoSerialized: readonly Buffer[]): AsyncGenerator<string> {
    return;
  }
}
