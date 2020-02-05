import { loadSync } from '@grpc/proto-loader';
import { GrpcObject, loadPackageDefinition, Client } from 'grpc';

const cogrpcPackageDefinition = loadSync(__dirname + '/cogrpc.proto', { keepCase: true });
const grpcPackage: GrpcObject = loadPackageDefinition(cogrpcPackageDefinition);
const service = (grpcPackage.relaynet as GrpcObject).cogrpc as GrpcObject;

export const GrpcClient = service.CargoRelay as typeof Client;
