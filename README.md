# CogRPC Implementation in JavaScript

This library implements [CogRPC](https://specs.relaynet.network/RS-008) in JavaScript with types included. It offers a CogRPC client and the building blocks to implement a CogRPC server.

As a [Cargo Relay Binding](https://specs.relaynet.network/RS-000#cargo-relay-binding), any CogRPC implementation is exclusively meant to be used by Relaynet gateways and couriers. Relaynet services do not need it at all.

This documentation assumes familiarity with CogRPC.

## Install

`@relaycorp/cogrpc` requires Node.js v10 or newer, and the latest stable release can be installed as follows:

```
npm install @relaycorp/cogrpc
```

Development releases use the `dev` tag (`@relaycorp/cogrpc@dev`).

## Use

### As a client

The first step to use the CogRPC client is to initialize it:

```js
import { CogRPCClient } from '@relaycorp/cogrpc';

const SERVER_URL = 'https://192.168.43.1';
const client = await CogRPCClient.init(SERVER_URL);
```

If the host name in `SERVER_URL` is a private IPv4/IPv6 address, self-issued certificates will be accepted. Under no other circumstances will self-issued certificates be accepted.

TLS is always required, but it can be made optional in development by setting the environment variable `COGRPC_REQUIRE_TLS` to `false`.

You can start delivering and collecting cargo once the client is initialized -- Simply use the client methods `deliverCargo()` and `collectCargo()`, respectively. For example, the following is an overly simplistic version of a courier synchronizing cargo with the public gateway at `https://gb.relaycorp.tech`:

```typescript
import { CogRPCClient } from '@relaycorp/cogrpc';
import { Cargo, CargoDeliveryRequest } from '@relaycorp/relaynet-core';
import { promises as fs } from 'fs';

const ROOT_DIR = '/var/cargoes';

async function main(): Promise<void> {
  const gwAddress = 'https://gb.relaycorp.tech';
  const client = await CogRPCClient.init(gwAddress);

  // Deliver cargo
  const outgoingCargoes = retrieveOutgoingCargoes(gwAddress);
  for await (const deliveredCargoPath of client.deliverCargo(outgoingCargoes)) {
    // Delete each cargo as soon as it's delivered
    await fs.unlink(deliveredCargoPath);
  }

  // Collect cargo
  const cca = await fs.readFile(`${ROOT_DIR}/ccas/${gwAddress}`);
  for await (const incomingCargo of client.collectCargo(cca)) {
    let cargo: Cargo;
    try {
      cargo = await Cargo.deserialize(incomingCargo);
      await cargo.validate();
    } catch (error) {
      continue;
    }
    const path = `${ROOT_DIR}/sneakernet-bound/${cargo.recipientAddress}/${cargo.id}`;
    await fs.writeFile(path, incomingCargo);
  }
}

async function* retrieveOutgoingCargoes(
  publicGatewayAddress: string,
): AsyncIterable<CargoDeliveryRequest> {
  const dir = `${ROOT_DIR}/internet-bound/${publicGatewayAddress}`;
  for await (const cargoPath of fs.readdir(dir)) {
    yield { cargo: await fs.readFile(cargoPath), localId: cargoPath };
  }
}
```

### In a server

If you're writing a CogRPC server in a courier or a public gateway, you may want to use the following values exported by this library:

- `CargoRelayService`, which is the ProtoBuf representation of the service.
- `CargoDelivery` and `CargoDeliveryAck`, which are TypeScript types representing the data exchanged over gRPC.

## Support

If you have any questions or comments, please [create an issue on GitHub](https://github.com/relaycorp/relaynet-cogrpc-js/issues/new/choose).

## Updates

Releases are automatically published on GitHub and NPM, and the [changelog can be found on GitHub](https://github.com/relaycorp/relaynet-cogrpc-js/releases). This project uses [semantic versioning](https://semver.org/).
