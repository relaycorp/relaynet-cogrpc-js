/* tslint:disable:no-let */

import { CargoRelay } from '@relaycorp/relaynet-core';
import { EventEmitter } from 'events';
import * as grpc from 'grpc';
import * as jestDateMock from 'jest-date-mock';

import { getMockContext, mockSpy } from './_test_utils';
import { CogRPCClient } from './client';
import * as grpcService from './grpcService';
import MockInstance = jest.MockInstance;

class MockDuplexStream extends EventEmitter {
  public readonly close = jest.fn();
  public readonly write = jest.fn();
}

let mockClientDuplexStream: MockDuplexStream;
let mockGrcpClient: Partial<grpc.Client> & { readonly deliverCargo: MockInstance<any, any> };
beforeEach(() => {
  mockClientDuplexStream = new MockDuplexStream();
  mockGrcpClient = {
    close: jest.fn(),
    deliverCargo: jest.fn().mockReturnValueOnce(mockClientDuplexStream),
  };
});
jest.mock('./grpcService', () => {
  return {
    GrpcClient: jest.fn().mockImplementation(() => mockGrcpClient),
  };
});

afterEach(() => {
  jestDateMock.clear();
});

const stubServerAddress = 'https://relaycorp.tech';

const mockStubUuid4 = '56e95d8a-6be2-4020-bb36-5dd0da36c181';
jest.mock('uuid-random', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => mockStubUuid4),
  };
});

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

  test('close() should close the client', () => {
    const client = new CogRPCClient(stubServerAddress);

    client.close();

    expect(mockGrcpClient.close).toBeCalledTimes(1);
    expect(mockGrcpClient.close).toBeCalledWith();
  });

  describe('deliverCargo', () => {
    test('Call metadata should not be set', () => {
      const client = new CogRPCClient(stubServerAddress);

      Array.from(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][0]).toEqual(undefined);
    });

    test('Deadline should be set to 2 seconds', () => {
      const client = new CogRPCClient(stubServerAddress);

      const currentDate = new Date();
      jestDateMock.advanceTo(currentDate);
      Array.from(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);

      const expectedDeadline = new Date(currentDate);
      expectedDeadline.setSeconds(expectedDeadline.getSeconds() + 2);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][1]).toEqual({ deadline: expectedDeadline });
    });

    test('Each cargo from input generator should be delivered', () => {
      const client = new CogRPCClient(stubServerAddress);

      const cargoRelays: readonly CargoRelay[] = [
        { relayId: 'one', cargo: Buffer.from('foo') },
        { relayId: 'two', cargo: Buffer.from('bar') },
      ];
      Array.from(client.deliverCargo(generateCargoRelays(cargoRelays)));

      expect(mockClientDuplexStream.write).toBeCalledTimes(2);
      expect(mockClientDuplexStream.write).toBeCalledWith(
        expect.objectContaining({
          cargo: cargoRelays[0].cargo,
        }),
      );
      expect(mockClientDuplexStream.write).toBeCalledWith(
        expect.objectContaining({
          cargo: cargoRelays[1].cargo,
        }),
      );
    });

    test('Relay ids from input generator should be replaced before sending to server', () => {
      const client = new CogRPCClient(stubServerAddress);

      const stubRelay = { relayId: 'original-id', cargo: Buffer.from('foo') };
      Array.from(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockClientDuplexStream.write).toBeCalledTimes(1);
      expect(mockClientDuplexStream.write).toBeCalledWith(
        expect.objectContaining({
          id: mockStubUuid4,
        }),
      );
    });

    test.todo('Each relay id acknowledged by the server should be yielded');

    test.todo('Unknown relay ids should close the connection and throw an error');

    test.todo('Connection should be closed when all relays have been acknowledged');

    test.todo('Stream errors should be thrown');

    test.todo('Connection should be closed when the server ends it first');

    test.todo(
      'Error should be thrown when server closes connection before acknowledging all relays',
    );

    function* generateCargoRelays(
      cargoRelays: readonly CargoRelay[],
    ): IterableIterator<CargoRelay> {
      yield* cargoRelays;
    }
  });
});
