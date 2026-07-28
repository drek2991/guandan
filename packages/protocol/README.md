# Protocol

`@guandan/protocol` contains environment-independent TypeScript contracts and runtime parsers shared by the mobile client and authoritative server.

The package currently exports:

- the temporary `scaffold:ping` event and acknowledgement used to verify baseline Socket.IO connectivity;
- the M0-009 infrastructure-only `infrastructure:database-smoke` command, success acknowledgement, structured failure acknowledgement, UUID-v4 validation, and strict runtime parsers.

The database smoke contract contains only a command ID and opaque probe token. It has no user identity, room state, gameplay revision, database information, or client-side secret. Lobby commands, gameplay commands, snapshots, authentication, and persistent multiplayer contracts remain unimplemented.

Run from the repository root:

```sh
npm run shared:typecheck
npm run shared:test
npm run shared:build
```
