import { loadSync } from '@grpc/proto-loader';
import {
  CallOptions,
  Client,
  ClientDuplexStream,
  GrpcObject,
  loadPackageDefinition,
  Metadata,
  ServerDuplexStream,
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

//region Client interface

type CargoRelayClientMethod<Req, Res> = (
  metadata?: Metadata,
  options?: CallOptions,
) => ClientDuplexStream<Req, Res>;
export interface CargoRelayClientMethodSet {
  readonly collectCargo: CargoRelayClientMethod<CargoDeliveryAck, CargoDelivery>;
  readonly deliverCargo: CargoRelayClientMethod<CargoDelivery, CargoDeliveryAck>;
}

// tslint:disable-next-line:variable-name
export const CargoRelayClient: typeof Client = service.CargoRelay as typeof Client;

//endregion

//region Server interface

type CargoRelayServerMethod<Req, Res> = (call: ServerDuplexStream<Req, Res>) => void;
export interface CargoRelayServerMethodSet {
  readonly collectCargo: CargoRelayServerMethod<CargoDeliveryAck, CargoDelivery>;
  readonly deliverCargo: CargoRelayServerMethod<CargoDelivery, CargoDeliveryAck>;
}

// @ts-ignore
// tslint:disable-next-line:variable-name
export const CargoRelayService = (CargoRelayClient as any)
  .service as ServiceDefinition<CargoRelayServerMethodSet>;

//endregion
