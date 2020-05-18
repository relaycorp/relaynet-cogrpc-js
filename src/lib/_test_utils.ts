/* tslint:disable:readonly-keyword */
import MockInstance = jest.MockInstance;
import grpc from 'grpc';
import { Duplex } from 'stream';

export function getMockContext(mockedObject: any): jest.MockContext<any, any> {
  const mockInstance = (mockedObject as unknown) as jest.MockInstance<any, any>;
  return mockInstance.mock;
}

// tslint:disable-next-line:readonly-array
export function mockSpy<T, Y extends any[]>(
  spy: MockInstance<T, Y>,
  mockImplementation?: () => any,
): MockInstance<T, Y> {
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

    while (this.output.length) {
      const canPushAgain = this.push(this.output.shift());
      if (!canPushAgain) {
        return;
      }
    }

    this.push(null);
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
