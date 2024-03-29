import { generateCargoRelays } from '../lib/_test_utils';
import { CogRPCClient } from '../lib/client';

test('Cargo delivery with a real gateway should succeed', async () => {
  const client = await CogRPCClient.initInternet('belgium.relaycorp.services');
  const localId = 'id';
  const deliveries = generateCargoRelays([{ localId, cargo: Buffer.from([]) }]);

  try {
    await expect(asyncIterableToArray(client.deliverCargo(deliveries))).resolves.toEqual([localId]);
  } finally {
    client.close();
  }
});

async function asyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  // tslint:disable-next-line:readonly-array
  const array = [];
  for await (const item of iterable) {
    array.push(item);
  }
  return array;
}
