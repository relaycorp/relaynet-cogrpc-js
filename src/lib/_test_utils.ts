// tslint:disable:readonly-keyword max-classes-per-file

import grpc from '@grpc/grpc-js';
import { CargoDeliveryRequest } from '@relaycorp/relaynet-core';
import { Duplex } from 'stream';

import * as grpcService from './grpcService';

export function getMockInstance(mockedObject: any): jest.MockInstance<any, any> {
  return mockedObject as any;
}

// tslint:disable-next-line:readonly-array
export function mockSpy<T, Y extends any[]>(
  spy: jest.MockInstance<T, Y>,
  mockImplementation?: (...args: readonly any[]) => any,
): jest.MockInstance<T, Y> {
  beforeEach(() => {
    spy.mockClear();
    if (mockImplementation) {
      spy.mockImplementation(mockImplementation);
    }
  });

  afterAll(() => {
    spy.mockRestore();
  });

  return spy;
}

export class MockGrpcBidiCall<Input, Output> extends Duplex {
  // tslint:disable-next-line:readonly-array
  public input: Input[] = [];
  // tslint:disable-next-line:readonly-array
  public output: Output[] = [];

  public metadata?: grpc.Metadata;

  public readError?: Error;

  public cancel = jest.fn();

  protected automaticallyEndReadStream = true;

  private readPosition = 0;

  constructor() {
    super({ objectMode: true });
  }

  public override _read(_size: number): void {
    if (this.readError) {
      this.destroy(this.readError);
      return;
    }

    while (this.output.length !== 0 && this.readPosition < this.output.length) {
      const canPushAgain = this.push(this.output[this.readPosition]);
      // tslint:disable:no-object-mutation
      this.readPosition += 1;
      if (!canPushAgain) {
        return;
      }
    }

    if (this.automaticallyEndReadStream) {
      this.push(null);
    }
  }

  public override _write(value: Input, _encoding: string, callback: (error?: Error) => void): void {
    this.input.push(value);
    callback();
  }

  public override end(cb?: () => void): void {
    this.push(null); // Close readable stream
    super.end(cb); // Close writable stream
  }
}

export class MockCargoDeliveryCall extends MockGrpcBidiCall<
  grpcService.CargoDelivery,
  grpcService.CargoDeliveryAck
> {
  public maxAcks?: number;

  protected override automaticallyEndReadStream = false;

  protected acksSent = 0;

  public override _write(
    value: grpcService.CargoDelivery,
    encoding: string,
    callback: (error?: Error) => void,
  ): void {
    super._write(value, encoding, () => {
      callback();

      if (this.maxAcks === undefined || this.acksSent < this.maxAcks) {
        const ack = { id: value.id };
        this.push(ack);
        this.acksSent++;
      }

      if (this.maxAcks === this.acksSent) {
        // Destroy the stream after the last ACK has been processed
        setImmediate(() => {
          this.destroy();
        });
      }
    });
  }
}

export async function* generateCargoRelays(
  cargoRelays: readonly CargoDeliveryRequest[],
): AsyncIterable<CargoDeliveryRequest> {
  for (const relay of cargoRelays) {
    yield relay;
  }
}
