// tslint:disable:no-object-mutation

import * as grpc from '@grpc/grpc-js';
import {
  BindingType,
  CargoDeliveryRequest,
  resolveInternetAddress,
} from '@relaycorp/relaynet-core';
import { EventEmitter } from 'events';
import * as jestDateMock from 'jest-date-mock';
import * as tls from 'tls';

import {
  generateCargoRelays,
  getMockInstance,
  MockCargoDeliveryCall,
  MockGrpcBidiCall,
  mockSpy,
} from './_test_utils';
import { CogRPCClient, CogRPCError } from './client';
import * as grpcService from './grpcService';

const INTERNET_ADDRESS = 'braavos.relaycorp.cloud';
const PRIVATE_IP_ADDRESS = '192.168.0.1';
const PUBLIC_IP_ADDRESS = '104.27.161.26';
const TARGET_HOST = 'braavos-cogrpc.relaycorp.cloud';
const PORT = 1234;

const OCTETS_IN_9_MIB = 9_437_184;

jest.mock('tls');
jest.mock('@relaycorp/relaynet-core', () => {
  const realRelaynet = jest.requireActual('@relaycorp/relaynet-core');
  return {
    ...realRelaynet,
    resolveInternetAddress: jest.fn(),
  };
});

let mockCargoDeliveryCall: MockCargoDeliveryCall;
let mockCargoCollectionCall: MockGrpcBidiCall<
  grpcService.CargoDeliveryAck,
  grpcService.CargoDelivery
>;
let mockGrcpClient: Partial<grpc.Client> & {
  readonly deliverCargo: jest.MockInstance<any, any>;
  readonly collectCargo: jest.MockInstance<any, any>;
};
beforeEach(() => {
  mockCargoDeliveryCall = new MockCargoDeliveryCall();
  mockCargoCollectionCall = new MockGrpcBidiCall();
  mockGrcpClient = {
    close: jest.fn(),
    collectCargo: jest.fn().mockImplementation((metadata) => {
      mockCargoCollectionCall.metadata = metadata;
      return mockCargoCollectionCall;
    }),
    deliverCargo: jest.fn().mockReturnValueOnce(mockCargoDeliveryCall),
  };
});
jest.mock('@grpc/grpc-js', () => {
  const actualGrpc = jest.requireActual('@grpc/grpc-js');
  return {
    ...actualGrpc,
    loadPackageDefinition(): grpc.GrpcObject {
      return {
        relaynet: {
          cogrpc: { CargoRelay: jest.fn().mockImplementation(() => mockGrcpClient) as any },
        },
      };
    },
  };
});

afterEach(() => {
  jestDateMock.clear();
});

//endregion

describe('CogRPCClient', () => {
  const createSslSpy = mockSpy(jest.spyOn(grpc.credentials, 'createSsl'));

  describe('initInternet', () => {
    beforeEach(() => {
      getMockInstance(resolveInternetAddress).mockResolvedValue({
        host: TARGET_HOST,
        port: PORT,
      });
    });
    afterEach(() => {
      getMockInstance(resolveInternetAddress).mockReset();
    });

    test('gRPC client should connect to Internet address resolved', async () => {
      await CogRPCClient.initInternet(INTERNET_ADDRESS);

      expect(resolveInternetAddress).toBeCalledWith(INTERNET_ADDRESS, BindingType.CRC);
      expect(grpcService.CargoRelayClient).toBeCalledWith(
        `${TARGET_HOST}:${PORT}`,
        expect.anything(),
        expect.anything(),
      );
    });

    test('Non-existing address should be refused', async () => {
      getMockInstance(resolveInternetAddress).mockResolvedValue(null);

      await expect(CogRPCClient.initInternet(INTERNET_ADDRESS)).rejects.toThrowWithMessage(
        CogRPCError,
        `Internet address "${INTERNET_ADDRESS}" doesn't exist`,
      );
    });

    test('TLS should be used', async () => {
      await CogRPCClient.initInternet(INTERNET_ADDRESS);

      expect(createSslSpy).toBeCalledWith();
      const credentials = createSslSpy.mock.results[0].value;
      expect(grpcService.CargoRelayClient).toBeCalledWith(
        expect.anything(),
        credentials,
        expect.anything(),
      );
    });

    test('Incoming messages of up to 9 MiB should be supported', async () => {
      await CogRPCClient.initInternet(INTERNET_ADDRESS);

      expect(grpcService.CargoRelayClient).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ 'grpc.max_receive_message_length': OCTETS_IN_9_MIB }),
      );
    });
  });

  describe('initLan', () => {
    const DUMMY_CERTIFICATE_DER = Buffer.from('Pretend this is a DER-encoded X.509 cert');
    let mockTLSSocket: MockTLSSocket;
    beforeEach(() => {
      mockTLSSocket = new MockTLSSocket(DUMMY_CERTIFICATE_DER);
      (tls.connect as any as jest.MockInstance<any, any>).mockImplementation((_, cb) => {
        setImmediate(cb);
        return mockTLSSocket;
      });
    });

    test('Private IP address with port should be accepted', async () => {
      const host = `${PRIVATE_IP_ADDRESS}:${PORT}`;

      await CogRPCClient.initLan(host);

      expect(grpcService.CargoRelayClient).toBeCalledWith(
        host,
        expect.anything(),
        expect.anything(),
      );
    });

    test('Port 443 should be used by default', async () => {
      await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      expect(grpcService.CargoRelayClient).toBeCalledWith(
        `${PRIVATE_IP_ADDRESS}:443`,
        expect.anything(),
        expect.anything(),
      );
    });

    test('Public IP address should be refused', async () => {
      await expect(CogRPCClient.initLan(PUBLIC_IP_ADDRESS)).rejects.toThrowWithMessage(
        CogRPCError,
        `Server is outside the current LAN (${PUBLIC_IP_ADDRESS})`,
      );
    });

    test('Domain name should be refused', async () => {
      await expect(CogRPCClient.initLan(INTERNET_ADDRESS)).rejects.toThrowWithMessage(
        CogRPCError,
        `Server is outside the current LAN (${INTERNET_ADDRESS})`,
      );
    });

    test('Incoming messages of up to 9 MiB should be supported', async () => {
      await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      expect(grpcService.CargoRelayClient).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ 'grpc.max_receive_message_length': OCTETS_IN_9_MIB }),
      );
    });

    describe('TLS server certificate validation', () => {
      test('Any TLS certificate should be accepted', async () => {
        await CogRPCClient.initLan(`${PRIVATE_IP_ADDRESS}:${PORT}`);

        expect(tls.connect).toBeCalledWith(
          expect.objectContaining({
            host: PRIVATE_IP_ADDRESS,
            port: PORT,
            rejectUnauthorized: false,
          }),
          expect.anything(),
        );

        expect(createSslSpy).toBeCalledTimes(1);
        const retrievedCertificatePem = createSslSpy.mock.calls[0][0];
        expect(retrievedCertificatePem).toBeInstanceOf(Buffer);
        expect(pemCertificateToDer(retrievedCertificatePem as Buffer)).toEqual(
          DUMMY_CERTIFICATE_DER,
        );
      });

      test('TLS socket should be closed immediately after use', async () => {
        await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

        expect(mockTLSSocket.end).toBeCalled();
      });

      test('TLS socket should timeout after 2 seconds', async () => {
        await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

        expect(mockTLSSocket.setTimeout).toBeCalledWith(2_000);
      });

      test('TLS connection errors should be thrown', async () => {
        const error = new Error('Failed to connected');
        (tls.connect as any as jest.MockInstance<any, any>).mockImplementation(() => {
          return mockTLSSocket;
        });
        setImmediate(() => {
          mockTLSSocket.emit('error', error);
        });

        await expect(CogRPCClient.initLan(PRIVATE_IP_ADDRESS)).rejects.toEqual(error);
      });

      test('Port 443 should be used by default', async () => {
        await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

        expect(tls.connect).toBeCalledWith(
          expect.objectContaining({ port: 443 }),
          expect.anything(),
        );
      });
    });
  });

  describe('initLocalhost', () => {
    test('Should connect to localhost on specified port', async () => {
      await CogRPCClient.initLocalhost(PORT);

      expect(grpcService.CargoRelayClient).toBeCalledWith(
        `127.0.0.1:${PORT}`,
        expect.anything(),
        expect.anything(),
      );
    });

    test('Should not use TLS', async () => {
      await CogRPCClient.initLocalhost(PORT);

      expect(createSslSpy).not.toBeCalled();
      expect(grpcService.CargoRelayClient).toBeCalledWith(
        expect.anything(),
        expect.toSatisfy<grpc.ChannelCredentials>((c) => !c._isSecure()),
        expect.anything(),
      );
    });

    test('Incoming messages of up to 9 MiB should be supported', async () => {
      await CogRPCClient.initLocalhost(PORT);

      expect(grpcService.CargoRelayClient).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ 'grpc.max_receive_message_length': OCTETS_IN_9_MIB }),
      );
    });
  });

  test('close() should close the client', async () => {
    const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

    client.close();

    expect(mockGrcpClient.close).toBeCalledTimes(1);
    expect(mockGrcpClient.close).toBeCalledWith();
  });

  describe('deliverCargo', () => {
    test('Call metadata should not be set', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][0]).toEqual(undefined);
    });

    test('Deadline should be set to 3 seconds', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      const currentDate = new Date();
      jestDateMock.advanceTo(currentDate);
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);

      const expectedDeadline = new Date(currentDate);
      expectedDeadline.setSeconds(expectedDeadline.getSeconds() + 3);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][1]).toEqual({ deadline: expectedDeadline });
    });

    test('No cargo should be delivered if input iterator is empty', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockCargoDeliveryCall.input).toEqual([]);
    });

    test('Each cargo from input iterator should be delivered', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      const cargoRelays: readonly CargoDeliveryRequest[] = [
        { localId: 'one', cargo: Buffer.from('foo') },
        { localId: 'two', cargo: Buffer.from('bar') },
      ];

      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays(cargoRelays)));

      expect(mockCargoDeliveryCall.input).toEqual([
        expect.objectContaining({ cargo: cargoRelays[0].cargo }),
        expect.objectContaining({ cargo: cargoRelays[1].cargo }),
      ]);
    });

    test('Relay ids from input iterator should be replaced before sending to server', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockCargoDeliveryCall.input).toHaveLength(1);
      expect(mockCargoDeliveryCall.input[0]).toHaveProperty('id');
      expect(mockCargoDeliveryCall.input[0]).not.toHaveProperty('id', stubRelay.localId);
    });

    test('Id of each relay acknowledged by the server should be yielded', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      expect(await consumeAsyncIterable(deliveredCargoIds)).toEqual([stubRelay.localId]);
    });

    test('Unknown relay ids should end the call and throw an error', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      const invalidAckId = 'unrecognized-id';
      mockCargoDeliveryCall.output.push({ id: invalidAckId });

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      await expect(consumeAsyncIterable(deliveredCargoIds)).rejects.toEqual(
        new CogRPCError(`Received unknown acknowledgment "${invalidAckId}" from the server`),
      );

      expect(mockCargoDeliveryCall.destroyed).toBeTrue();
    });

    test('Connection should be ended when all relays have been acknowledged', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockCargoDeliveryCall.destroyed).toBeTrue();
      expect(mockCargoDeliveryCall.cancel).toBeCalled();
    });

    test('Stream errors should be thrown', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      mockCargoDeliveryCall.readError = new Error('Random error found');

      await expect(
        consumeAsyncIterable(client.deliverCargo(generateCargoRelays([]))),
      ).rejects.toEqual(
        new CogRPCError(mockCargoDeliveryCall.readError, 'Unexpected error while delivering cargo'),
      );
    });

    test('Call should be ended when the server ends it while delivering cargo', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      const localId = 'original-id';

      async function* generateRelays(): AsyncIterable<CargoDeliveryRequest> {
        yield { localId, cargo: Buffer.from('foo') };

        await new Promise(setImmediate);
        mockCargoDeliveryCall.emit('end');

        yield { localId: 'should not be sent', cargo: Buffer.from('bar') };
      }

      let iterationCount = 0;
      for await (const ackId of client.deliverCargo(generateRelays())) {
        // Check that at least the results prior to the end event were yielded
        expect(ackId).toEqual(localId);
        iterationCount++;
      }

      expect(iterationCount).toEqual(1);

      expect(mockCargoDeliveryCall.destroyed).toBeTrue();
    });

    test('Error should be thrown when connection ends with outstanding acknowledgments', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      mockCargoDeliveryCall.maxAcks = 1;

      const acknowledgedDelivery = { localId: 'acknowledged', cargo: Buffer.from('foo') };
      const unacknowledgedDelivery = { localId: 'unacknowledged', cargo: Buffer.from('bar') };

      const cargoDelivery = client.deliverCargo(
        generateCargoRelays([acknowledgedDelivery, unacknowledgedDelivery]),
      );

      let error: CogRPCError | undefined;
      // tslint:disable-next-line:readonly-array
      const acks = [];
      try {
        for await (const ackId of cargoDelivery) {
          acks.push(ackId);
        }
      } catch (err) {
        error = err as any;
      }

      expect(acks).toEqual([acknowledgedDelivery.localId]);

      expect(error).toEqual(new CogRPCError('Server did not acknowledge all cargo deliveries'));
    });
  });

  describe('collectCargo', () => {
    const CCA = Buffer.from('The RAMF-serialized CCA');

    test('CCA should be passed in call metadata Authorization', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      await consumeAsyncIterable(client.collectCargo(CCA));

      const authorizationMetadata = mockCargoCollectionCall.metadata!.get('Authorization');
      expect(authorizationMetadata).toHaveLength(1);
      expect(authorizationMetadata[0]).toEqual(`Relaynet-CCA ${CCA.toString('base64')}`);
    });

    test('Deadline should be set to 3 seconds', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

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
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);

      await expect(consumeAsyncIterable(client.collectCargo(CCA))).resolves.toHaveLength(0);
    });

    test('Each cargo received should be yielded serialized', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      const cargoSerialized = Buffer.from('cargo');
      mockCargoCollectionCall.output.push({ id: 'the-id', cargo: cargoSerialized });

      const cargoesDelivered = await consumeAsyncIterable(client.collectCargo(CCA));

      expect(cargoesDelivered).toEqual([cargoSerialized]);
    });

    test('Each cargo received should be acknowledged', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      const deliveryId = 'the-id';
      mockCargoCollectionCall.output.push({ id: deliveryId, cargo: Buffer.from('cargo') });

      await consumeAsyncIterable(client.collectCargo(CCA));

      expect(mockCargoCollectionCall.input).toEqual([{ id: deliveryId }]);
    });

    test('Unprocessed cargo should not be acknowledged', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
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

    test('Call should be ended upon completion', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      mockCargoCollectionCall.output.push({ id: 'the-id', cargo: Buffer.from('cargo') });

      await consumeAsyncIterable(client.collectCargo(CCA));
    });

    test('Stream errors should be thrown and cause the call to end', async () => {
      const client = await CogRPCClient.initLan(PRIVATE_IP_ADDRESS);
      mockCargoCollectionCall.readError = new Error('Whoopsie');

      await expect(consumeAsyncIterable(client.collectCargo(CCA))).rejects.toEqual(
        new CogRPCError(
          mockCargoCollectionCall.readError,
          'Unexpected error while collecting cargo',
        ),
      );
      expect(mockCargoCollectionCall.destroyed).toBeTrue();
    });
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

function pemCertificateToDer(pemBuffer: Buffer): Buffer {
  const content = pemBuffer.toString().replace(/(-----(BEGIN|END) (CERTIFICATE)-----|\n)/g, '');
  return Buffer.from(content, 'base64');
}

class MockTLSSocket extends EventEmitter {
  public readonly end = jest.fn();
  public readonly setTimeout = jest.fn();
  public readonly getPeerCertificate: jest.Mock;

  constructor(serverCertificateDer: Buffer) {
    super();

    this.getPeerCertificate = jest.fn().mockReturnValue({ raw: serverCertificateDer });
  }
}
