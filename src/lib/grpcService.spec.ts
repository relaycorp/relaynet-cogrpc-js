// import * as grpc from 'grpc';

import { CargoRelayClient } from './grpcService';

test('gRPC service should be computed and output', () => {
  expect(CargoRelayClient).toHaveProperty('service.CollectCargo');
  expect(CargoRelayClient).toHaveProperty('service.DeliverCargo');
});
