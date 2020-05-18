// tslint:disable:no-let no-object-mutation

import { CargoDeliveryRequest } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import * as jestDateMock from 'jest-date-mock';
import { Duplex } from 'stream';

import { getMockContext, MockGrpcBidiCall, mockSpy } from './_test_utils';
import { CogRPCClient, CogRPCError } from './client';
import * as grpcService from './grpcService';

//region Fixtures

let mockCargoRelayStream: CargoRelayStreamSpy; // TODO: Change to MockGrpcBidiCall
let mockCargoCollectionCall: MockGrpcBidiCall<
  grpcService.CargoDeliveryAck,
  grpcService.CargoDelivery
>;
let mockGrcpClient: Partial<grpc.Client> & {
  readonly deliverCargo: jest.MockInstance<any, any>;
  readonly collectCargo: jest.MockInstance<any, any>;
};
beforeEach(() => {
  mockCargoRelayStream = new CargoRelayStreamSpy({ objectMode: true });
  mockCargoCollectionCall = new MockGrpcBidiCall();
  mockGrcpClient = {
    close: jest.fn(),
    collectCargo: jest.fn().mockImplementation((metadata) => {
      mockCargoCollectionCall.metadata = metadata;
      return mockCargoCollectionCall;
    }),
    deliverCargo: jest.fn().mockReturnValueOnce(mockCargoRelayStream),
  };
});
jest.mock('grpc', () => {
  const actualGrpc = jest.requireActual('grpc');
  return {
    ...actualGrpc,
    loadPackageDefinition(): grpc.GrpcObject {
      return {
        relaynet: { cogrpc: { CargoRelay: jest.fn().mockImplementation(() => mockGrcpClient) } },
      };
    },
  };
});

afterEach(() => {
  jestDateMock.clear();
});

const stubServerAddress = 'https://relaycorp.tech';

//endregion

describe('CogRPCClient', () => {
  describe('constructor', () => {
    const createSslSpy = mockSpy(jest.spyOn(grpc.credentials, 'createSsl'));
    const createInsecureSpy = mockSpy(jest.spyOn(grpc.credentials, 'createInsecure'));

    test('gRPC client must be initialized with specified server address', () => {
      // tslint:disable-next-line:no-unused-expression
      new CogRPCClient(stubServerAddress);

      expect(grpcService.CargoRelayClient).toBeCalledTimes(1);
      const clientInitializationArgs = getMockContext(grpcService.CargoRelayClient).calls[0];
      expect(clientInitializationArgs[0]).toEqual(stubServerAddress);
    });

    test('TSL should be used by default', () => {
      // tslint:disable-next-line:no-unused-expression
      new CogRPCClient(stubServerAddress);

      expect(createSslSpy).toBeCalledTimes(1);
      const credentials = createSslSpy.mock.results[0].value;
      const clientInitializationArgs = getMockContext(grpcService.CargoRelayClient).calls[0];
      expect(clientInitializationArgs[1]).toBe(credentials);
    });

    test('TSL can be disabled', () => {
      // tslint:disable-next-line:no-unused-expression
      new CogRPCClient(stubServerAddress, false);

      expect(createInsecureSpy).toBeCalledTimes(1);
      const credentials = createInsecureSpy.mock.results[0].value;
      const clientInitializationArgs = getMockContext(grpcService.CargoRelayClient).calls[0];
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

    test('Deadline should be set to 3 seconds', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const currentDate = new Date();
      jestDateMock.advanceTo(currentDate);
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);

      const expectedDeadline = new Date(currentDate);
      expectedDeadline.setSeconds(expectedDeadline.getSeconds() + 3);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][1]).toEqual({ deadline: expectedDeadline });
    });

    test('Each cargo from input iterator should be delivered', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const cargoRelays: readonly CargoDeliveryRequest[] = [
        { localId: 'one', cargo: Buffer.from('foo') },
        { localId: 'two', cargo: Buffer.from('bar') },
      ];

      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays(cargoRelays)));

      expect(mockCargoRelayStream.cargoDeliveries).toEqual([
        expect.objectContaining({ cargo: cargoRelays[0].cargo }),
        expect.objectContaining({ cargo: cargoRelays[1].cargo }),
      ]);
    });

    test('Relay ids from input iterator should be replaced before sending to server', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockCargoRelayStream.cargoDeliveries).toHaveLength(1);
      expect(mockCargoRelayStream.cargoDeliveries[0]).toHaveProperty('id');
      expect(mockCargoRelayStream.cargoDeliveries[0]).not.toHaveProperty('id', stubRelay.localId);
    });

    test('Id of each relay acknowledged by the server should be yielded', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      expect(await consumeAsyncIterable(deliveredCargoIds)).toEqual([stubRelay.localId]);
    });

    test('Unknown relay ids should end the call and throw an error', async () => {
      const client = new CogRPCClient(stubServerAddress);
      const invalidAckId = 'unrecognized-id';
      mockCargoRelayStream.addAck(invalidAckId);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      await expect(consumeAsyncIterable(deliveredCargoIds)).rejects.toEqual(
        new CogRPCError(`Received unknown acknowledgment "${invalidAckId}" from the server`),
      );

      expect(mockCargoRelayStream.end).toBeCalledTimes(1);
    });

    test('Connection should be closed when all relays have been acknowledged', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockCargoRelayStream.end).toBeCalledTimes(1);
    });

    test('Stream errors should be thrown', async () => {
      const client = new CogRPCClient(stubServerAddress);
      const error = new Error('Random error found');

      const localId = 'original-id';

      function* generateRelays(): IterableIterator<CargoDeliveryRequest> {
        yield { localId, cargo: Buffer.from('foo') };
      }

      // tslint:disable-next-line:readonly-array
      const acks: string[] = [];
      await expect(
        (async () => {
          for await (const ackId of client.deliverCargo(generateRelays())) {
            acks.push(ackId);
            if (acks.length === 1) {
              mockCargoRelayStream.emit('error', error);
            }
          }
        })(),
      ).rejects.toEqual(new CogRPCError(error, 'Unexpected error while delivering cargo'));

      expect(acks).toEqual([localId]);

      expect(mockCargoRelayStream.end).toBeCalledTimes(1);
    });

    test('Call should be ended when the server ends it while delivering cargo', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const localId = 'original-id';

      function* generateRelays(): IterableIterator<CargoDeliveryRequest> {
        yield { localId, cargo: Buffer.from('foo') };
        mockCargoRelayStream.emit('end');
        yield { localId: 'should not be sent', cargo: Buffer.from('bar') };
      }

      let iterationCount = 0;
      for await (const ackId of client.deliverCargo(generateRelays())) {
        // Check that at least the results prior to the end event were yielded
        expect(ackId).toEqual(localId);
        iterationCount++;
      }

      expect(iterationCount).toEqual(1);

      expect(mockCargoRelayStream.end).toBeCalledTimes(1);
    });

    test('Error should be thrown when connection ends with outstanding acknowledgments', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const acknowledgedDelivery = { localId: 'acknowledged', cargo: Buffer.from('foo') };
      const unacknowledgedDelivery = { localId: 'unacknowledged', cargo: Buffer.from('bar') };

      const cargoDelivery = client.deliverCargo(
        generateCargoRelays([acknowledgedDelivery, unacknowledgedDelivery]),
      );
      mockCargoRelayStream.maxAcks = 1;

      let error: CogRPCError | undefined;
      // tslint:disable-next-line:readonly-array
      const acks = [];
      try {
        for await (const ackId of cargoDelivery) {
          acks.push(ackId);
        }
      } catch (err) {
        error = err;
      }

      expect(error).toEqual(new CogRPCError('Server did not acknowledge all cargo deliveries'));

      expect(acks).toEqual([acknowledgedDelivery.localId]);

      expect(mockCargoRelayStream.end).toBeCalledTimes(1);
    });

    function* generateCargoRelays(
      cargoRelays: readonly CargoDeliveryRequest[],
    ): IterableIterator<CargoDeliveryRequest> {
      yield* cargoRelays;
    }
  });

  describe('collectCargo', () => {
    const CCA = Buffer.from('The RAMF-serialized CCA');

    test('CCA should be passed in call metadata Authorization', async () => {
      const client = new CogRPCClient(stubServerAddress);

      await consumeAsyncIterable(client.collectCargo(CCA));

      const authorizationMetadata = mockCargoCollectionCall.metadata!.get('Authorization');
      expect(authorizationMetadata).toHaveLength(1);
      expect(authorizationMetadata[0]).toEqual(`Relaynet-CCA ${CCA.toString('base64')}`);
    });

    test('Deadline should be set to 3 seconds', async () => {
      const client = new CogRPCClient(stubServerAddress);

      const currentDate = new Date();
      jestDateMock.advanceTo(currentDate);
      await consumeAsyncIterable(client.collectCargo(CCA));

      const expectedDeadline = new Date(currentDate);
      expectedDeadline.setSeconds(expectedDeadline.getSeconds() + 3);
      expect(mockGrcpClient.collectCargo).toBeCalledTimes(1);
      expect(mockGrcpClient.collectCargo).toBeCalledWith(expect.anything(), {
        deadline: expectedDeadline,
      });
    });

    test('No cargo should be yielded if none was received', async () => {
      const client = new CogRPCClient(stubServerAddress);

      await expect(consumeAsyncIterable(client.collectCargo(CCA))).resolves.toHaveLength(0);
    });

    test('Each cargo received should be yielded serialized', async () => {
      const client = new CogRPCClient(stubServerAddress);
      const cargoSerialized = Buffer.from('cargo');
      mockCargoCollectionCall.output.push({ id: 'the-id', cargo: cargoSerialized });

      const cargoesDelivered = await consumeAsyncIterable(client.collectCargo(CCA));

      expect(cargoesDelivered).toEqual([cargoSerialized]);
    });

    test('Each cargo received should be acknowledged', async () => {
      const client = new CogRPCClient(stubServerAddress);
      const deliveryId = 'the-id';
      mockCargoCollectionCall.output.push({ id: deliveryId, cargo: Buffer.from('cargo') });

      await consumeAsyncIterable(client.collectCargo(CCA));

      expect(mockCargoCollectionCall.input).toEqual([{ id: deliveryId }]);
    });

    test('Unprocessed cargo should not be acknowledged', async () => {
      const client = new CogRPCClient(stubServerAddress);
      const processedCargoId = 'processed-cargo';
      mockCargoCollectionCall.output.push({ id: processedCargoId, cargo: Buffer.from('cargo1') });
      mockCargoCollectionCall.output.push({ id: 'id2', cargo: Buffer.from('cargo2') });

      // Only consume the first cargo:
      let done = false;
      for await (const _ of client.collectCargo(CCA)) {
        if (done) {
          break;
        }
        done = true;
      }

      // Only the first delivery should be acknowledged
      expect(mockCargoCollectionCall.input).toEqual([{ id: processedCargoId }]);
    });

    test('Stream errors should be thrown', async () => {
      const client = new CogRPCClient(stubServerAddress);
      mockCargoCollectionCall.readError = new Error('Whoopsie');

      await expect(consumeAsyncIterable(client.collectCargo(CCA))).rejects.toEqual(
        new CogRPCError(
          mockCargoCollectionCall.readError,
          'Unexpected error while collecting cargo',
        ),
      );
    });
  });
});

class CargoRelayStreamSpy extends Duplex {
  public readonly end = jest.fn();
  // tslint:disable-next-line:readonly-array
  public readonly cargoDeliveries: grpcService.CargoDelivery[] = [];
  // tslint:disable-next-line:readonly-array readonly-keyword
  public ackIds: string[] = [];

  // tslint:disable-next-line:readonly-keyword
  public maxAcks: number | undefined;
  // tslint:disable-next-line:readonly-keyword
  public acksCount = 0;

  public addAck(ackId: string): void {
    this.ackIds.push(ackId);
  }

  public _read(_size: number): void {
    while (this.ackIds.length) {
      if (this.maxAcks !== undefined && this.maxAcks <= this.acksCount) {
        break;
      }
      const canPushAgain = this.push({ id: this.ackIds.shift() });
      this.acksCount++;
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
    this.addAck(ack.id);
    callback(null);
  }
}

async function consumeAsyncIterable<V>(iter: AsyncIterable<V>): Promise<readonly V[]> {
  // tslint:disable-next-line:readonly-array
  const values = [];
  for await (const value of iter) {
    values.push(value);
  }
  return values;
}
