import SpyInstance = jest.SpyInstance;

export function getMockContext(mockedObject: any): jest.MockContext<any, any> {
  const mockInstance = (mockedObject as unknown) as jest.MockInstance<any, any>;
  return mockInstance.mock;
}

export function mockSpy(spy: SpyInstance, mockImplementation?: () => any): SpyInstance {
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
