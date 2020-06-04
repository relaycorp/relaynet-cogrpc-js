# CogRPC Implementation in JavaScript

This project implements [CogRPC](https://specs.relaynet.network/RS-008) in JavaScript with types included. As a [Cargo Relay Binding](https://specs.relaynet.network/RS-000#cargo-relay-binding), this library is only meant to be used by Relaynet gateways and couriers.

## Install

`@relaycorp/cogrpc` requires Node.js v10 or newer, and the latest stable release can be installed as follows:

```
npm install --save @relaycorp/cogrpc
```

Development releases use the `dev` tag (`@relaycorp/cogrpc@dev`).

Environment variables:

- `COGRPC_REQUIRE_TLS`
