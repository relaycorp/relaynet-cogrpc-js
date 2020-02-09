import { loadSync } from '@grpc/proto-loader';
import {
  CallOptions,
  Client,
  ClientDuplexStream,
  GrpcObject,
  loadPackageDefinition,
  Metadata,
  ServiceDefinition,
} from 'grpc';

const cogrpcPackageDefinition = loadSync(__dirname + '/cogrpc.proto', { keepCase: true });
const grpcPackage: GrpcObject = loadPackageDefinition(cogrpcPackageDefinition);
const service = (grpcPackage.relaynet as GrpcObject).cogrpc as GrpcObject;

export interface CargoDelivery {
  readonly id: string;
  readonly cargo: Buffer;
}

export interface CargoDeliveryAck {
  readonly id: string;
}

export type CargoRelayStream<Req, Res> = (
  metadata?: Metadata,
  options?: CallOptions,
) => ClientDuplexStream<Req, Res>;

export interface CargoRelayService {
  readonly deliverCargo: CargoRelayStream<CargoDelivery, CargoDeliveryAck>;
  readonly collectCargo: CargoRelayStream<CargoDeliveryAck, CargoDelivery>;
}

// tslint:disable-next-line:variable-name
export const GrpcClient: typeof Client = service.CargoRelay as typeof Client;

// @ts-ignore
export const CARGO_DELIVERY_GRPC_SERVICE = GrpcClient.service as ServiceDefinition<
  CargoRelayService
>;
