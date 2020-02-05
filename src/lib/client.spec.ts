import * as grpc from 'grpc';

import { getMockContext, mockSpy } from './_test_utils';
import { CogRPCClient } from './client';
import * as grpcService from './grpcService';

jest.mock('./grpcService');

const stubServerAddress = 'https://relaycorp.tech';

describe('CogRPCClient', () => {
  describe('constructor', () => {
    const createSslSpy = mockSpy(jest.spyOn(grpc.credentials, 'createSsl'));
    const createInsecureSpy = mockSpy(jest.spyOn(grpc.credentials, 'createInsecure'));

    test('gRPC client must be initialized with specified server address', () => {
      // tslint:disable-next-line:no-unused-expression
      new CogRPCClient(stubServerAddress);

      expect(grpcService.GrpcClient).toBeCalledTimes(1);
      const clientInitializationArgs = getMockContext(grpcService.GrpcClient).calls[0];
      expect(clientInitializationArgs[0]).toEqual(stubServerAddress);
    });

    test('TSL should be used by default', () => {
      // tslint:disable-next-line:no-unused-expression
      new CogRPCClient(stubServerAddress);

      expect(createSslSpy).toBeCalledTimes(1);
      const credentials = createSslSpy.mock.results[0].value;
      const clientInitializationArgs = getMockContext(grpcService.GrpcClient).calls[0];
      expect(clientInitializationArgs[1]).toBe(credentials);
    });

    test('TSL can be disabled', () => {
      // tslint:disable-next-line:no-unused-expression
      new CogRPCClient(stubServerAddress, false);

      expect(createInsecureSpy).toBeCalledTimes(1);
      const credentials = createInsecureSpy.mock.results[0].value;
      const clientInitializationArgs = getMockContext(grpcService.GrpcClient).calls[0];
      expect(clientInitializationArgs[1]).toBe(credentials);
    });
  });

  test.todo('close() should close the client');

  describe('deliverCargo', () => {
    test.todo('Deadline should be set to 2 seconds');

    test.todo('Each cargo from input generator should be delivered');

    test.todo('Each relay id acknowledged by the server should be yielded');

    test.todo('Relay ids yielded by generator should be replaced before sent to server');

    test.todo('Unknown relay ids should close the connection and throw an error');

    test.todo('Connection should be closed when all relays have been acknowledged');

    test.todo('Stream errors should be thrown');

    test.todo('Connection should be closed when the server ends it first');

    test.todo(
      'Error should be thrown when server closes connection before acknowledging all relays',
    );
  });
});
