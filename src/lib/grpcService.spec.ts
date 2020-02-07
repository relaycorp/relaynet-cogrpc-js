// import * as grpc from 'grpc';

import { GrpcClient } from './grpcService';

test('gRPC service should be computed and output', () => {
  expect(GrpcClient).toHaveProperty('service.CollectCargo');
  expect(GrpcClient).toHaveProperty('service.DeliverCargo');
});
