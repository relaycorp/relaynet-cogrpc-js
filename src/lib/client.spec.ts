/* tslint:disable:no-let */

import { CargoDelivery } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import * as jestDateMock from 'jest-date-mock';
import { Duplex } from 'stream';

import { getMockContext, mockSpy } from './_test_utils';
import { CogRPCClient } from './client';
import * as grpcService from './grpcService';
import MockInstance = jest.MockInstance;

class BidiStreamCallSpy extends Duplex {
  // tslint:disable-next-line:readonly-array
  public readonly cargoDeliveries: grpcService.CargoDelivery[] = [];
  // tslint:disable-next-line:readonly-array readonly-keyword
  public ackIds: string[] = [];

  public addAck(ackId: string): void {
    this.ackIds.push(ackId);
  }

  public _read(_size: number): void {
    while (this.ackIds.length) {
      const canPushAgain = this.push({ id: this.ackIds.shift() });
      if (!canPushAgain) {
        return;
      }
    }

    this.push(null);
  }

  public _write(
    ack: grpcService.CargoDelivery,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.cargoDeliveries.push(ack);
    callback(null);
  }
}

let mockClientDuplexStream: BidiStreamCallSpy;
let mockGrcpClient: Partial<grpc.Client> & { readonly deliverCargo: MockInstance<any, any> };
beforeEach(() => {
  mockClientDuplexStream = new BidiStreamCallSpy({ objectMode: true });
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
    test('Call metadata should not be set', async () => {
      const client = new CogRPCClient(stubServerAddress);

      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][0]).toEqual(undefined);
    });

    test('Deadline should be set to 2 seconds', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const currentDate = new Date();
      jestDateMock.advanceTo(currentDate);
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);

      const expectedDeadline = new Date(currentDate);
      expectedDeadline.setSeconds(expectedDeadline.getSeconds() + 2);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][1]).toEqual({ deadline: expectedDeadline });
    });

    test('Each cargo from input iterator should be delivered', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const cargoRelays: readonly CargoDelivery[] = [
        { localId: 'one', cargo: Buffer.from('foo') },
        { localId: 'two', cargo: Buffer.from('bar') },
      ];
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays(cargoRelays)));

      expect(mockClientDuplexStream.cargoDeliveries).toEqual([
        expect.objectContaining({ cargo: cargoRelays[0].cargo }),
        expect.objectContaining({ cargo: cargoRelays[1].cargo }),
      ]);
    });

    test('Relay ids from input iterator should be replaced before sending to server', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockClientDuplexStream.cargoDeliveries).toHaveLength(1);
      expect(mockClientDuplexStream.cargoDeliveries[0]).toHaveProperty('id', mockStubUuid4);
    });

    test('Id of each relay acknowledged by the server should be yielded', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      mockClientDuplexStream.addAck(mockStubUuid4);

      let ackCount = 0;
      for await (const ackId of deliveredCargoIds) {
        expect(ackId).toEqual(stubRelay.localId);
        ackCount++;
      }

      expect(ackCount).toEqual(1);
    });

    test.todo('Unknown relay ids should close the connection and throw an error');

    test.todo('Connection should be closed when all relays have been acknowledged');

    test.todo('Stream errors should be thrown');

    test.todo('Connection should be closed when the server ends it first');

    test.todo(
      'Error should be thrown when server closes connection before acknowledging all relays',
    );

    function* generateCargoRelays(
      cargoRelays: readonly CargoDelivery[],
    ): IterableIterator<CargoDelivery> {
      yield* cargoRelays;
    }
  });
});

async function consumeAsyncIterable<V>(iter: AsyncIterable<V>): Promise<readonly V[]> {
  // tslint:disable-next-line:readonly-array
  const values = [];
  for await (const _value of iter) {
    values.push(_value);
  }
  return values;
}
