# Protocol

`@guandan/protocol` contains environment-independent TypeScript contracts and runtime parsers shared by the mobile client and authoritative server.

The package currently exports:

- the temporary `scaffold:ping` event and acknowledgement used to verify baseline Socket.IO connectivity;
- the M0-009 infrastructure-only `infrastructure:database-smoke` command, success acknowledgement, structured failure acknowledgement, UUID-v4 validation, and strict runtime parsers.

The database smoke contract contains only a command ID and opaque probe token. It has no user identity, room state, gameplay revision, database information, or client-side secret.

M1-001 adds lobby contract foundations without adding command behavior:

- canonical UUID-v4 room, player, and command identifiers;
- strict room codes, display-name normalization, revisions, seats, settings, and connection status;
- versioned, player-specific `LobbySnapshotV1` parsing;
- structural start eligibility and informational viewer capabilities;
- exact existing-room mutation metadata and success/error acknowledgement foundations.

The snapshot never exposes internal display-name keys, join order, password material, socket association, or reconnect credentials. See [`docs/m1-001-lobby-state-foundations.md`](../../docs/m1-001-lobby-state-foundations.md) for the exact foundation contracts and extension rules.

M1-002 adds the exact `lobby:create-room` event, normalized create command, revision-0 success contract, and create-specific structured errors. The command contains only command ID, display name, starting level, and turn timer; all room/player authority remains server generated. Join-room and every other lobby mutation, password support, persistence, authentication, gameplay contracts, and mobile UI remain unimplemented. See [`docs/m1-002-authoritative-room-creation.md`](../../docs/m1-002-authoritative-room-creation.md).

Run from the repository root:

```sh
npm run shared:typecheck
npm run shared:test
npm run shared:build
```
