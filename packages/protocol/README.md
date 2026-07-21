# Protocol

`@guandan/protocol` contains environment-independent TypeScript contracts shared by clients and servers. It currently exports only the temporary scaffold connectivity event and acknowledgement used to verify package consumption.

Lobby commands, gameplay commands, snapshots, authentication, and persistent multiplayer contracts are not implemented. The scaffold contract is replaceable and is not the future gameplay protocol.

Run from the repository root:

```sh
npm run shared:typecheck
npm run shared:build
```
