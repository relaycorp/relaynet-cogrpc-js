import * as grpc from 'grpc';

import { GrpcClient } from './grpcService';

export class CogRPCClient {
  protected readonly grpcClient: grpc.Client;

  constructor(serverAddress: string, useTls = true) {
    const credentials = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.grpcClient = new GrpcClient(serverAddress, credentials);
  }

  public close(): void {
    this.grpcClient.close();
  }
}
