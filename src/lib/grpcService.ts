import { loadSync } from '@grpc/proto-loader';
import {
  CallOptions,
  Client,
  ClientDuplexStream,
  GrpcObject,
  loadPackageDefinition,
  Metadata,
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

type BidiStreamRequest<Req, Res> = (
  metadata: Metadata,
  options: CallOptions,
) => ClientDuplexStream<Req, Res>;

export interface CargoRelayService {
  readonly deliverCargo: BidiStreamRequest<CargoDelivery, CargoDeliveryAck>;
  readonly collectCargo: BidiStreamRequest<CargoDeliveryAck, CargoDelivery>;
}

// tslint:disable-next-line:variable-name
export const GrpcClient: typeof Client = service.CargoRelay as typeof Client;
