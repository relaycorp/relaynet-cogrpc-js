// tslint:disable:no-object-mutation

import * as relaynet from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import * as jestDateMock from 'jest-date-mock';
import * as tls from 'tls';

import {
  generateCargoRelays,
  getMockContext,
  MockCargoDeliveryCall,
  MockGrpcBidiCall,
  mockSpy,
} from './_test_utils';
import { CogRPCClient, CogRPCError } from './client';
import * as grpcService from './grpcService';

jest.mock('tls');
jest.mock('@relaycorp/relaynet-core', () => {
  const realRelaynet = jest.requireActual('@relaycorp/relaynet-core');
  return { ...realRelaynet, resolvePublicAddress: jest.fn() };
});

//region Fixtures

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

const HOST = 'relaycorp.tech';
const URL = `https://${HOST}`;
const TARGET_HOST = 'cogrpc.relaycorp.tech';
const TARGET_PORT = 1234;

const mockResolvePublicAddress = mockSpy(
  jest.spyOn(relaynet, 'resolvePublicAddress'),
  async () => ({
    host: TARGET_HOST,
    port: TARGET_PORT,
  }),
);

//endregion

describe('CogRPCClient', () => {
  describe('init', () => {
    const createSslSpy = mockSpy(jest.spyOn(grpc.credentials, 'createSsl'));

    test('gRPC client should connect to public address if resolved', async () => {
      await CogRPCClient.init(`https://${HOST}`);

      expect(grpcService.CargoRelayClient).toBeCalledTimes(1);
      const clientInitializationArgs = getMockContext(grpcService.CargoRelayClient).calls[0];
      expect(clientInitializationArgs[0]).toEqual(`${TARGET_HOST}:${TARGET_PORT}`);
    });

    test('gRPC client should connect to host on port 443 if address is unresolved', async () => {
      mockResolvePublicAddress.mockResolvedValue(null);

      await CogRPCClient.init(`https://${HOST}`);

      expect(grpcService.CargoRelayClient).toBeCalledTimes(1);
      const clientInitializationArgs = getMockContext(grpcService.CargoRelayClient).calls[0];
      expect(clientInitializationArgs[0]).toEqual(`${HOST}:443`);
    });

    test('TLS should be used', async () => {
      await CogRPCClient.init(URL);

      expect(createSslSpy).toBeCalledTimes(1);
      const credentials = createSslSpy.mock.results[0].value;
      const clientInitializationArgs = getMockContext(grpcService.CargoRelayClient).calls[0];
      expect(clientInitializationArgs[1]).toBe(credentials);
    });

    test('Non-TLS connections must be refused', async () => {
      await expect(CogRPCClient.init(`http://${HOST}`)).rejects.toEqual(
        new CogRPCError(`Cannot connect to ${HOST} without TLS`),
      );
    });

    describe('TLS server certificate validation', () => {
      const PRIVATE_IP = '192.168.0.1';
      const PORT = 1234;

      const DUMMY_CERTIFICATE_DER = Buffer.from('Pretend this is a DER-encoded X.509 cert');
      const MOCK_TLS_SOCKET = {
        end: mockSpy(jest.fn()),
        getPeerCertificate: mockSpy(jest.fn(), () => ({ raw: DUMMY_CERTIFICATE_DER })),
      };
      beforeEach(() => {
        ((tls.connect as any) as jest.MockInstance<any, any>).mockImplementation((_, cb) => {
          setImmediate(cb);
          return MOCK_TLS_SOCKET;
        });
      });

      describe('Private IP address as target host', () => {
        test('Any TLS certificate should be accepted', async () => {
          mockResolvePublicAddress.mockResolvedValue({ host: PRIVATE_IP, port: PORT });

          await CogRPCClient.init(`https://${PRIVATE_IP}:${PORT}`);

          expect(tls.connect).toBeCalledWith(
            expect.objectContaining({ host: PRIVATE_IP, port: PORT, rejectUnauthorized: false }),
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
          mockResolvePublicAddress.mockResolvedValue({ host: PRIVATE_IP, port: PORT });

          await CogRPCClient.init(`https://${PRIVATE_IP}`);

          expect(MOCK_TLS_SOCKET.end).toBeCalled();
        });

        test('Port 443 should be used if public address is not resolved', async () => {
          mockResolvePublicAddress.mockResolvedValue(null);

          await CogRPCClient.init(`https://${PRIVATE_IP}`);

          expect(tls.connect).toBeCalledWith(
            expect.objectContaining({ port: 443 }),
            expect.anything(),
          );
        });

        test('Any certificate should be accepted if SRV resolves to private IP', async () => {
          mockResolvePublicAddress.mockResolvedValue({ host: PRIVATE_IP, port: TARGET_PORT });

          await CogRPCClient.init(`https://${HOST}`);

          expect(tls.connect).toBeCalledWith(
            expect.objectContaining({ host: PRIVATE_IP, port: TARGET_PORT }),
            expect.anything(),
          );
        });
      });

      test('TLS certificate validity should be enforced if host is a public IP address', async () => {
        await CogRPCClient.init('https://104.27.161.26');

        expect(tls.connect).not.toBeCalled();
        expect(createSslSpy).toBeCalledWith();
      });

      test('TLS certificate validity should be enforced if SRV resolves to domain', async () => {
        await CogRPCClient.init('https://example.com');

        expect(tls.connect).not.toBeCalled();
        expect(createSslSpy).toBeCalledWith();
      });
    });

    test('Incoming messages of up to 9 MiB should be supported', async () => {
      await CogRPCClient.init(URL);

      expect(grpcService.CargoRelayClient).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          'grpc.max_receive_message_length': 9_437_184,
        }),
      );
    });
  });

  test('close() should close the client', async () => {
    const client = await CogRPCClient.init(URL);

    client.close();

    expect(mockGrcpClient.close).toBeCalledTimes(1);
    expect(mockGrcpClient.close).toBeCalledWith();
  });

  describe('deliverCargo', () => {
    test('Call metadata should not be set', async () => {
      const client = await CogRPCClient.init(URL);

      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][0]).toEqual(undefined);
    });

    test('Deadline should be set to 3 seconds', async () => {
      const client = await CogRPCClient.init(URL);

      const currentDate = new Date();
      jestDateMock.advanceTo(currentDate);
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([])));

      expect(mockGrcpClient.deliverCargo).toBeCalledTimes(1);

      const expectedDeadline = new Date(currentDate);
      expectedDeadline.setSeconds(expectedDeadline.getSeconds() + 3);
      expect(mockGrcpClient.deliverCargo.mock.calls[0][1]).toEqual({ deadline: expectedDeadline });
    });

    test('Each cargo from input iterator should be delivered', async () => {
      const client = await CogRPCClient.init(URL);

      const cargoRelays: readonly relaynet.CargoDeliveryRequest[] = [
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
      const client = await CogRPCClient.init(URL);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockCargoDeliveryCall.input).toHaveLength(1);
      expect(mockCargoDeliveryCall.input[0]).toHaveProperty('id');
      expect(mockCargoDeliveryCall.input[0]).not.toHaveProperty('id', stubRelay.localId);
    });

    test('Id of each relay acknowledged by the server should be yielded', async () => {
      const client = await CogRPCClient.init(URL);

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      expect(await consumeAsyncIterable(deliveredCargoIds)).toEqual([stubRelay.localId]);
    });

    test('Unknown relay ids should end the call and throw an error', async () => {
      const client = await CogRPCClient.init(URL);
      const invalidAckId = 'unrecognized-id';
      mockCargoDeliveryCall.output.push({ id: invalidAckId });

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      const deliveredCargoIds = client.deliverCargo(generateCargoRelays([stubRelay]));

      await expect(consumeAsyncIterable(deliveredCargoIds)).rejects.toEqual(
        new CogRPCError(`Received unknown acknowledgment "${invalidAckId}" from the server`),
      );

      expect(mockCargoDeliveryCall.end).toBeCalledTimes(1);
    });

    test('Connection should be ended when all relays have been acknowledged', async () => {
      const client = await CogRPCClient.init(URL);
      mockCargoDeliveryCall.automaticallyEndReadStream = false;

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay])));

      expect(mockCargoDeliveryCall.end).toBeCalledTimes(1);
    });

    test('Stream errors should be thrown', async () => {
      const client = await CogRPCClient.init(URL);
      mockCargoDeliveryCall.readError = new Error('Random error found');

      const stubRelay = { localId: 'original-id', cargo: Buffer.from('foo') };
      await expect(
        consumeAsyncIterable(client.deliverCargo(generateCargoRelays([stubRelay]))),
      ).rejects.toEqual(
        new CogRPCError(mockCargoDeliveryCall.readError, 'Unexpected error while delivering cargo'),
      );

      expect(mockCargoDeliveryCall.end).toBeCalledTimes(1);
    });

    test('Call should be ended when the server ends it while delivering cargo', async () => {
      const client = await CogRPCClient.init(URL);

      const localId = 'original-id';

      function* generateRelays(): IterableIterator<relaynet.CargoDeliveryRequest> {
        yield { localId, cargo: Buffer.from('foo') };
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

      expect(mockCargoDeliveryCall.end).toBeCalledTimes(1);
    });

    test('Error should be thrown when connection ends with outstanding acknowledgments', async () => {
      const client = await CogRPCClient.init(URL);
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
        error = err;
      }

      expect(acks).toEqual([acknowledgedDelivery.localId]);

      expect(error).toEqual(new CogRPCError('Server did not acknowledge all cargo deliveries'));

      expect(mockCargoDeliveryCall.end).toBeCalledTimes(1);
    });
  });

  describe('collectCargo', () => {
    const CCA = Buffer.from('The RAMF-serialized CCA');

    test('CCA should be passed in call metadata Authorization', async () => {
      const client = await CogRPCClient.init(URL);

      await consumeAsyncIterable(client.collectCargo(CCA));

      const authorizationMetadata = mockCargoCollectionCall.metadata!.get('Authorization');
      expect(authorizationMetadata).toHaveLength(1);
      expect(authorizationMetadata[0]).toEqual(`Relaynet-CCA ${CCA.toString('base64')}`);
    });

    test('Deadline should be set to 3 seconds', async () => {
      const client = await CogRPCClient.init(URL);

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
      const client = await CogRPCClient.init(URL);

      await expect(consumeAsyncIterable(client.collectCargo(CCA))).resolves.toHaveLength(0);
    });

    test('Each cargo received should be yielded serialized', async () => {
      const client = await CogRPCClient.init(URL);
      const cargoSerialized = Buffer.from('cargo');
      mockCargoCollectionCall.output.push({ id: 'the-id', cargo: cargoSerialized });

      const cargoesDelivered = await consumeAsyncIterable(client.collectCargo(CCA));

      expect(cargoesDelivered).toEqual([cargoSerialized]);
    });

    test('Each cargo received should be acknowledged', async () => {
      const client = await CogRPCClient.init(URL);
      const deliveryId = 'the-id';
      mockCargoCollectionCall.output.push({ id: deliveryId, cargo: Buffer.from('cargo') });

      await consumeAsyncIterable(client.collectCargo(CCA));

      expect(mockCargoCollectionCall.input).toEqual([{ id: deliveryId }]);
    });

    test('Unprocessed cargo should not be acknowledged', async () => {
      const client = await CogRPCClient.init(URL);
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
      const client = await CogRPCClient.init(URL);
      mockCargoCollectionCall.output.push({ id: 'the-id', cargo: Buffer.from('cargo') });

      await consumeAsyncIterable(client.collectCargo(CCA));

      expect(mockCargoCollectionCall.emit).toBeCalledWith('end');
    });

    test('Stream errors should be thrown and cause the call to end', async () => {
      const client = await CogRPCClient.init(URL);
      mockCargoCollectionCall.readError = new Error('Whoopsie');

      await expect(consumeAsyncIterable(client.collectCargo(CCA))).rejects.toEqual(
        new CogRPCError(
          mockCargoCollectionCall.readError,
          'Unexpected error while collecting cargo',
        ),
      );
      expect(mockCargoCollectionCall.emit).toBeCalledWith('end');
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
