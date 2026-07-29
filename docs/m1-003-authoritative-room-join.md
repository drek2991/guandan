# M1-003 authoritative room join

M1-003 adds the process-local authoritative `lobby:join-room` flow. A connected, unbound Socket.IO client submits an exact room code and raw display name; the server normalizes the name, enforces room access constraints, appends one immutable non-host membership at revision +1, binds the socket, and returns a player-specific `LobbySnapshotV1`. No snapshot is broadcast.

## Event and command

The shared event is:

```text
lobby:join-room
```

The exact command contains:

```text
commandId
roomCode
displayName
```

The room code is exactly six uppercase characters from the M1-001 alphabet. The protocol parser does not trim, uppercase, or otherwise repair it. The display name uses the shared NFKC, control rejection, whitespace normalization, and 1–24-code-point rules. All client authority, settings, password, connection, seat, readiness, revision, join-order, and display-name-key fields are rejected as extras.

## Lookup, access checks, and error precedence

After payload parsing and global receipt resolution, a new join uses this order:

1. `ALREADY_IN_ROOM`
2. `ROOM_NOT_FOUND`
3. Protected-room defensive rejection as sanitized `INTERNAL_ERROR`
4. `ROOM_FULL`
5. `NAME_TAKEN`

Receipt conflicts take precedence over membership and lookup, so a globally claimed command ID always returns `COMMAND_ID_CONFLICT` unless it is the exact same socket/kind/canonical join retry.

Current create-room state always has `hasPassword: false`. If injected or future state has `hasPassword: true`, this passwordless command rejects it before capacity or name checks, revealing no protected-room details. Password access requires a separate contract.

Capacity is four players. Name uniqueness compares the server-derived `toLocaleLowerCase('en-US')` key from the canonical name, so case, padding, and NFKC-equivalent forms conflict.

## Joined player state

The server generates and validates a UUID-v4 player ID. The appended player contains:

```text
playerId: generated
displayName: canonical input
displayNameKey: server derived
joinOrder: max(existing joinOrder) + 1
seat: null
ready: false
connectionStatus: connected
```

Join order and display-name key remain private. Join order is derived from the maximum rather than array position; unsafe-integer overflow fails as sanitized `INTERNAL_ERROR`. Duplicate generated player IDs fail before replacement.

The host, phase, settings, room ID/code, every existing player field, and existing player order remain exactly unchanged. Only revision and the appended player change.

## Revision and immutable repository replacement

The next revision is exactly current revision +1. Revision overflow is rejected; revisions never wrap or reset.

The repository exposes only a narrow expected-revision replacement:

```text
replaceRoom(roomId, expectedRevision, nextRoom)
```

Before replacing, it confirms:

- the current room exists;
- the room-code index maps to the same room ID;
- current revision equals the expected revision;
- the revision can increment safely and next revision is exactly +1;
- room ID/code, phase, host, settings, and every existing player/order are unchanged;
- exactly one player is appended;
- the complete next state passes M1-001 invariants.

It deep-clones and recursively freezes the next room, swaps only the ID-index value synchronously, preserves the code index and room count, and returns the actual previous immutable reference plus the new stored reference. Corrupt indexes are not repaired silently.

## Conditional rollback

After replacement, binding, projection, acknowledgement validation, or receipt insertion can still fail. Rollback attempts both conditional socket unbinding and exact room restoration even if either action fails.

Restoration requires the currently stored room still to be the replacement produced by the matching operation at the expected post-join revision, with matching ID/code/indexes, while the supplied previous room must be that replacement's recorded prior immutable value at the exact preceding revision and pass complete invariants. It restores a deep-cloned, recursively frozen value equivalent to the previous room and refuses reconstructed inputs, newer state, or unrelated state. Any cleanup failure becomes sanitized `INTERNAL_ERROR`; no success receipt is stored.

## Global lobby command IDs

Create and join share one process-local receipt store keyed globally by command ID. Receipts are discriminated by `create-room` or `join-room` and store the originating socket, canonical payload, and exact deep-frozen success.

Rules:

- Exact same socket/kind/canonical payload returns the original success without generation, binding, projection, revision change, or mutation.
- Different kind, socket, room code, or canonical name returns `COMMAND_ID_CONFLICT`.
- Another socket never receives the original success.
- Receipt replacement is rejected.
- Invalid and failed commands store no receipt and may later retry.

Existing create-room replay, generator suppression, bound-socket behavior, acknowledgement shape, and failure behavior remain unchanged.

## Success and errors

Join success reuses the lobby mutation success shape:

```text
status: ok
commandId
roomRevision
snapshot
```

The strict join parser requires revision at least 1, 2–4 players, self distinct from host, the self player connected/unseated/not-ready/non-host, exactly one host, all non-host capabilities false, and `hasPassword: false`. Later revisions are valid.

Supported errors are:

```text
INVALID_PAYLOAD
ROOM_NOT_FOUND
COMMAND_ID_CONFLICT
INVALID_LOBBY_STATE
INTERNAL_ERROR
ALREADY_IN_ROOM
ROOM_FULL
NAME_TAKEN
```

Malformed input alone maps to `INVALID_PAYLOAD`. Invalid constructed room/success contracts map to `INVALID_LOBBY_STATE`. Generator defects, duplicate IDs, overflows, protected rooms, repository/receipt/rollback faults, stale expected revisions, and unexpected errors map to `INTERNAL_ERROR`. Acknowledgements contain no raw exception or repository detail.

## Synchronous runtime and Socket.IO boundary

The full operation is synchronous: receipt lookup, membership/access checks, ID/order/revision derivation, validation/replacement, binding, projection, acknowledgement validation, receipt insertion, and return have no asynchronous gap. Repository expected-revision replacement remains the authoritative mutation boundary.

The Socket.IO handler passes only socket identity plus the raw payload to the shared per-process runtime and returns the structured acknowledgement. Success logs may include operation, command ID, room ID, player ID, and status. Failure logs may include operation, valid command ID, status, and error code. Logs exclude room code, display name/key, socket ID, raw command/snapshot, receipt contents, and exception details.

The handler does not build state, inspect repository indexes, generate IDs, access the database, call `socket.join`, or broadcast.

## In-memory limitations and exclusions

Rooms, connection bindings, and receipts remain process-local and disappear on restart. There is no cross-instance synchronization or durable idempotency.

M1-003 adds no mobile join/name screen, room links, passwords, `socket.join`, snapshot broadcasting, seating/readiness/settings mutation, leave/disconnect cleanup, host transfer, removal, room deletion, reconnection, persistence, authentication, accounts, match start, cards, rules, or gameplay.

Later tickets may add broadcasts, seating/readiness, password access, leave/disconnect lifecycle, and persistence by using explicit approved immutable replacement contracts rather than mutating frozen room state.
