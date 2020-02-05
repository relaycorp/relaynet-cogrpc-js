import { loadSync } from '@grpc/proto-loader';
import { Client, GrpcObject, loadPackageDefinition } from 'grpc';

const cogrpcPackageDefinition = loadSync(__dirname + '/cogrpc.proto', { keepCase: true });
const grpcPackage: GrpcObject = loadPackageDefinition(cogrpcPackageDefinition);
const service = (grpcPackage.relaynet as GrpcObject).cogrpc as GrpcObject;

// tslint:disable-next-line:variable-name
export const GrpcClient: typeof Client = service.CargoRelay as typeof Client;
