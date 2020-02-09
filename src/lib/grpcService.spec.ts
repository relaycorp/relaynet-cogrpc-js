// import * as grpc from 'grpc';

import { CargoDeliveryClient } from './grpcService';

test('gRPC service should be computed and output', () => {
  expect(CargoDeliveryClient).toHaveProperty('service.CollectCargo');
  expect(CargoDeliveryClient).toHaveProperty('service.DeliverCargo');
});
