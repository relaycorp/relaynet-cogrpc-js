/* tslint:disable:readonly-keyword max-classes-per-file */

import grpc from 'grpc';
import { Duplex } from 'stream';

import * as grpcService from './grpcService';

export function getMockContext(mockedObject: any): jest.MockContext<any, any> {
  const mockInstance = (mockedObject as unknown) as jest.MockInstance<any, any>;
  return mockInstance.mock;
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

  public automaticallyEndReadStream = true;

  public readError?: Error;

  private readPosition = 0;

  constructor() {
    super({ objectMode: true });

    // Mimic what the gRPC client would do
    this.on('error', () => this.end());

    jest.spyOn(this, 'emit' as any);
    jest.spyOn(this, 'on' as any);
    jest.spyOn(this, 'end' as any);
    jest.spyOn(this, 'write' as any);
  }

  public _read(_size: number): void {
    if (this.readError) {
      throw this.readError;
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

  public _write(value: Input, _encoding: string, callback: (error?: Error) => void): void {
    this.input.push(value);
    callback();
  }

  public end(cb?: () => void): void {
    super.end(cb);
    this.emit('end');
  }
}

export class MockCargoDeliveryCall extends MockGrpcBidiCall<
  grpcService.CargoDelivery,
  grpcService.CargoDeliveryAck
> {
  public maxAcks?: number;

  public _write(
    value: grpcService.CargoDelivery,
    _encoding: string,
    callback: (error?: Error) => void,
  ): void {
    super._write(value, _encoding, callback);
    if (this.maxAcks === undefined || this.output.length < this.maxAcks) {
      this.output.push({ id: value.id });
    }
  }
}
