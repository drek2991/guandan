# M1-002 authoritative room creation

M1-002 implements the first authoritative lobby runtime flow. A connected Socket.IO client may submit one `lobby:create-room` command, receive a player-specific revision-0 `LobbySnapshotV1`, and safely retry the same command. This slice does not implement joining, passwords, room broadcasts, state mutations, persistence, disconnect handling, or mobile UI.

## Event and command

The shared event constant is:

```text
lobby:create-room
```

The exact command is:

```text
commandId
displayName
settings:
  startingLevel
  turnTimer
```

`commandId` is a canonical lowercase UUID v4. The parser accepts raw display-name input and applies the M1-001 NFKC, control rejection, whitespace normalization, and 1–24-code-point rules. Settings accept only starting level `2` or `7` and turn timer `off`, `30`, or `60`.

The parser rejects missing and extra fields. Clients cannot supply room ID, room code, player ID, revision, host, seat, readiness, `hasPassword`, or `displayNameKey`.

## Server-authoritative initial state

The server generates room and player UUID-v4 identifiers with Node's cryptographic `randomUUID`. It generates the room code separately and constructs this room:

```text
roomId: generated
roomCode: generated
revision: 0
phase: lobby
hostPlayerId: generated creator player ID
settings:
  startingLevel: command value
  turnTimer: command value
  hasPassword: false
players: exactly one creator
```

The creator is canonicalized, assigned join order `0`, left unseated and not ready, marked connected, and made host. The server derives the private display-name key. The complete room passes the existing M1-001 invariant validator before insertion.

The returned success contains `status: ok`, the accepted command ID, room revision `0`, and the creator-specific snapshot. The shared create-success parser verifies that self equals host, the creator is the only player, host capabilities are present, `canStartMatch` is false, and `hasPassword` is false.

## Repository and ownership

The process-local repository maintains independent indexes:

```text
roomId → room
roomCode → roomId
```

It supports insertion, lookup by ID or code, code-existence checks, rollback deletion, and count. Insertion is the authoritative uniqueness boundary and rejects duplicate room IDs or codes without partially modifying either index. The earlier availability check is advisory.

The repository validates, deep-clones, and recursively freezes inserted rooms. It owns the stored immutable value; callers cannot mutate stored room, settings, player records, or the player array in place. Future lobby mutation work must introduce a separately approved state-replacement operation. M1-002 adds no update operation.

Rollback deletion removes both indexes only for the stored room being rolled back.

## Room-code allocation

Room codes use exactly six characters from:

```text
ABCDEFGHJKLMNPQRSTUVWXYZ23456789
```

Production candidates use Node's cryptographic `randomInt`; `Math.random` is not used. Candidate generation is injectable for deterministic tests.

Allocation makes at most 32 attempts. Indexed collisions are skipped. If authoritative repository insertion detects a duplicate code after an advisory availability check, that collision consumes an attempt and allocation continues. After 32 collisions, creation returns `ROOM_CODE_UNAVAILABLE`; it never makes a 33rd attempt or changes the code format.

Duplicate generated room IDs are not retried as code collisions and become sanitized `INTERNAL_ERROR` responses.

## Connection registry

Live membership is stored separately as:

```text
socketId → roomId + playerId
```

Binding rejects an already-bound socket. The registry supports conditional rollback unbinding. Socket IDs are not stored in `LobbyRoomState`, included in snapshots, or logged by the create-room handler.

M1-002 does not unbind on disconnect, create reconnect credentials, transfer hosts, or delete empty rooms.

## Idempotency receipts

Successful create commands are tracked process-locally by command ID. Each immutable receipt records the originating socket, normalized command fields, and exact success acknowledgement.

Rules:

- Same socket, same command ID, same normalized payload: return the stored success without running UUID/code generators or creating another room.
- Same socket, same command ID, different normalized payload: `COMMAND_ID_CONFLICT`.
- Different socket, same command ID: `COMMAND_ID_CONFLICT`, without revealing the prior success.
- Same socket, new command ID after successful creation: `ALREADY_IN_ROOM`.

Receipt insertion rejects replacement. Receipts are stored only after room insertion, binding, snapshot projection, and success parsing. Invalid and transient failures are not cached, so the same command may later be retried. Receipts are lost on process restart.

## Atomicity and rollback

The create service is synchronous. There is no asynchronous gap between receipt lookup, membership check, allocation/insertion, binding, projection, success validation, and receipt insertion. Process-local operations therefore cannot interleave midway through one creation.

If failure occurs after insertion, the service conditionally unbinds the socket and removes the room from both indexes. It stores no receipt. Receipt insertion failure also rolls back the binding and room. Cleanup failure is returned only as sanitized `INTERNAL_ERROR`.

Expected client/state errors are separated:

```text
INVALID_PAYLOAD
COMMAND_ID_CONFLICT
ALREADY_IN_ROOM
ROOM_CODE_UNAVAILABLE
INVALID_LOBBY_STATE
INTERNAL_ERROR
```

Acknowledgements contain bounded messages and an independently valid command ID when known. They never contain raw exceptions, stack traces, repository details, socket IDs, credentials, or environment values.

## Socket.IO handler

`apps/server/src/server.ts` registers the shared event and passes only socket identity plus the raw payload to the process-local lobby runtime. It returns the service acknowledgement and catches unexpected runtime failures so the server survives.

Success logging includes operation, command ID, room ID, player ID, and status. Failure logging includes operation, a valid command ID when known, status, and structured code. It does not log room code, display name, socket ID, raw command, or exception details.

The handler does not construct state, generate identifiers/codes, inspect repository maps, access the database, call `socket.join`, or broadcast. Existing health, readiness, `scaffold:ping`, infrastructure database smoke, and shutdown behavior remain unchanged.

## In-memory limitations and exclusions

Rooms, live bindings, and receipts are process-local and disappear on restart. Code uniqueness is limited to one server process; there is no database uniqueness, cross-instance synchronization, distributed lock, persistence, or graceful-shutdown storage.

M1-002 includes no join command, room lookup UI, link, password support, seat/readiness/settings mutation, removal, host transfer, leave, disconnect cleanup, reconnection, room deletion, match start, authentication, account, card, rules, gameplay, mobile UI, or Socket.IO room broadcasting.

M1-003 may add join-room behavior by using the existing code index, repository ownership rule, invariant validator, connection registry, revision semantics, and player-specific projection. It must add mutation/replacement semantics explicitly rather than mutating frozen room state.
