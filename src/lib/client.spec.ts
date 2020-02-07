/* tslint:disable:no-let */

import { CargoDelivery } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import * as jestDateMock from 'jest-date-mock';
import { Duplex } from 'stream';

import { getMockContext, mockSpy } from './_test_utils';
import * as grpcService from './grpcService';

import MockInstance = jest.MockInstance;

class BidiStreamCallSpy extends Duplex {
  public readonly end = jest.fn();
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

const mockStubUuids: readonly string[] = ['first-uuid4', 'second-uuid4'];
jest.mock('uuid-random', () => {
  const mockUuidRandom = jest.fn();
  mockStubUuids.map(s => mockUuidRandom.mockReturnValueOnce(s));
  mockUuidRandom.mockImplementationOnce(() => {
    throw new Error('Exhausted stub UUID4 array');
  });
  return {
    __esModule: true,
    default: mockUuidRandom,
  };
});
import { CogRPCClient, CogRPCError } from './client';

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
      [mockStubUuids[0], mockStubUuids[1]].map(s => mockClientDuplexStream.addAck(s));

      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays(cargoRelays)));

      expect(mockClientDuplexStream.cargoDeliveries).toEqual([
        expect.objectContaining({ cargo: cargoRelays[0].cargo }),
        expect.objectContaining({ cargo: cargoRelays[1].cargo }),
      ]);
    });

    test('Relay ids from input iterator should be replaced before sending to server', async () => {
      const client = new CogRPCClient(stubServerAddress);
      mockClientDuplexStream.addAck(mockStubUuids[0]);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockClientDuplexStream.cargoDeliveries).toHaveLength(1);
      expect(mockClientDuplexStream.cargoDeliveries[0]).toHaveProperty('id', mockStubUuids[0]);
    });

    test('Id of each relay acknowledged by the server should be yielded', async () => {
      const client = new CogRPCClient(stubServerAddress);

      mockClientDuplexStream.addAck(mockStubUuids[0]);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      expect(await consumeAsyncIterable(deliveredCargoIds)).toEqual([stubRelay.localId]);
    });

    test('Unknown relay ids should end the call and throw an error', async () => {
      const client = new CogRPCClient(stubServerAddress);
      const invalidAckId = 'unrecognized-id';
      mockClientDuplexStream.addAck(invalidAckId);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      await expect(consumeAsyncIterable(deliveredCargoIds)).rejects.toEqual(
        new CogRPCError(`Received unknown acknowledgment "${invalidAckId}" from the server`),
      );

      expect(mockClientDuplexStream.end).toBeCalledTimes(1);
    });

    test('Connection should be closed when all relays have been acknowledged', async () => {
      const client = new CogRPCClient(stubServerAddress);
      mockClientDuplexStream.addAck(mockStubUuids[0]);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockClientDuplexStream.end).toBeCalledTimes(1);
    });

    test('Stream errors should be thrown', async () => {
      const client = new CogRPCClient(stubServerAddress);
      const error = new CogRPCError('Bazinga');

      const localId = 'original-id';

      function* generateRelays(): IterableIterator<CargoDelivery> {
        yield { localId, cargo: Buffer.from('foo') };
        mockClientDuplexStream.emit('error', error);
      }

      // tslint:disable-next-line:readonly-array
      const acks: string[] = [];
      await expect(async () => {
        for await (const ackId of client.deliverCargo(generateRelays())) {
          acks.push(ackId);
        }
      }).rejects.toEqual(error);

      expect(acks).toEqual([localId]);

      expect(mockClientDuplexStream.end).toBeCalledTimes(1);
    });

    test('Connection should be closed when the server ends it first', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const localId = 'original-id';

      function* generateRelays(): IterableIterator<CargoDelivery> {
        yield { localId, cargo: Buffer.from('foo') };
        mockClientDuplexStream.emit('end');
        yield { localId: 'should not be sent', cargo: Buffer.from('bar') };
      }

      let iterationCount = 0;
      for await (const ackId of client.deliverCargo(generateRelays())) {
        // Check that at least the results prior to the end event were yielded
        expect(ackId).toEqual(localId);
        iterationCount++;
      }

      expect(iterationCount).toEqual(1);

      expect(mockClientDuplexStream.end).toBeCalledTimes(1);
    });

    test('Error should be thrown when connection ends with outstanding acknowledgments', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const acknowledgedDelivery = { localId: 'acknowledged', cargo: Buffer.from('foo') };
      const unacknowledgedDelivery = { localId: 'unacknowledged', cargo: Buffer.from('bar') };

      mockClientDuplexStream.addAck(mockStubUuids[0]);
      const cargoDelivery = client.deliverCargo(
        generateCargoRelays([acknowledgedDelivery, unacknowledgedDelivery]),
      );

      let error: CogRPCError | undefined;
      // tslint:disable-next-line:readonly-array
      const acks: string[] = [];
      try {
        for await (const ackId of cargoDelivery) {
          acks.push(ackId);
        }
      } catch (err) {
        error = err;
      }

      expect(error).toEqual(new CogRPCError('Server did not acknowledge all cargo deliveries'));

      expect(acks).toEqual([acknowledgedDelivery.localId]);

      expect(mockClientDuplexStream.end).toBeCalledTimes(1);
    });

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
  for await (const value of iter) {
    values.push(value);
  }
  return values;
}
