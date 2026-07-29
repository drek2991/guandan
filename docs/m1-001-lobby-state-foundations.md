# M1-001 lobby state foundations

M1-001 defines the authoritative in-memory lobby model and the shared, versioned contracts that later M1 room commands will use. It does not create or join rooms, register Socket.IO handlers, persist state, or add mobile UI.

## Ownership boundaries

- `apps/server/src/lobby` owns internal room and player state, complete-state invariants, structural start eligibility, deterministic ordering, and player-specific projection.
- `@guandan/protocol` owns public identifiers, settings, player records, `LobbySnapshotV1`, viewer capabilities, mutation metadata, acknowledgement foundations, and strict runtime parsers.
- `@guandan/game-domain` remains reserved for deterministic card rules and is unchanged.

Lobby membership, room access, host authority, readiness, connection state, and seat ownership are application concerns. The server remains authoritative, and later handlers must enforce authorization even though snapshots expose informational capabilities.

## Shared primitives

Room IDs, player IDs, and command IDs are opaque lowercase canonical UUID-v4 strings. Player IDs are safe to expose but are not reconnect credentials. Existing-room mutation metadata contains an independently validated `commandId` plus a nonnegative safe-integer `knownRevision`.

`INITIAL_LOBBY_REVISION` is `0`. It is the creation constant, not a parser restriction: revisions may be any nonnegative safe integer and will increment only after accepted authoritative mutations in later tickets. Room creation has no existing revision and will use a separate create command contract in M1-002 rather than inventing a known revision.

Room codes contain exactly six characters from:

```text
ABCDEFGHJKLMNPQRSTUVWXYZ23456789
```

The parser accepts only canonical uppercase codes. It does not silently uppercase input. `I`, `O`, `0`, and `1` are excluded, and generation and collision handling remain future work.

Seats are exactly `0`, `1`, `2`, and `3`. Opposite partners are `0 ↔ 2` and `1 ↔ 3`.

## Display names

Display-name input uses this deterministic rule:

1. Apply Unicode NFKC normalization.
2. Reject `\r`, `\n`, Unicode line separator, Unicode paragraph separator, and remaining Unicode `Cc` control characters.
3. Trim leading and trailing whitespace.
4. Collapse internal whitespace runs to one ASCII space.
5. Require 1–24 Unicode code points, counted by code-point iteration rather than UTF-16 code units.
6. Preserve that normalized display form for presentation.
7. Derive the room-uniqueness key with `normalizedDisplayName.toLocaleLowerCase('en-US')`.

Unicode `Cf` format characters are not rejected broadly, so valid emoji sequences containing zero-width joiners remain usable. `Alex`, `alex`, full-width `Ａｌｅｘ`, and padded `Alex` all derive the same key, `alex`.

The public player contract exposes only the canonical display name. The snapshot parser derives uniqueness keys itself; `displayNameKey` remains server-internal.

## Internal authoritative model

A retained `LobbyRoomState` contains only:

```text
roomId
roomCode
revision
phase: "lobby"
hostPlayerId
settings
players
```

Internal settings contain only:

```text
startingLevel: 2 | 7
turnTimer: "off" | 30 | 60
hasPassword: boolean
```

They contain no plaintext password, hash, salt, or verification metadata.

Each `LobbyPlayerState` contains:

```text
playerId
displayName
displayNameKey
joinOrder
seat
ready
connectionStatus
```

`displayNameKey` supports authoritative uniqueness checks. `joinOrder` is a stable nonnegative safe integer reserved for deterministic host transfer and unseated ordering. Both are private. A seat is `0`–`3` or `null`; a ready player must be seated. Connection status is `connected` or `disconnected`, and a disconnected member may remain seated, ready, or host.

The exact-field invariant checks reject secret or transport fields such as passwords, password hashes, socket IDs, reconnect credentials, database configuration, and mobile environment values.

## Complete-state invariants

The pure invariant validator requires:

- exact authoritative room, settings, and player fields;
- phase `lobby`;
- valid room ID, code, and nonnegative safe-integer revision;
- one through four players;
- a valid host ID that references a room member;
- valid and unique player IDs;
- canonical display names and matching derived keys;
- unique display-name keys;
- unique nonnegative safe-integer join orders;
- valid nullable seats with no duplicate occupied seat;
- boolean readiness and no ready-unseated player;
- valid connection status.

It rejects invalid state with a deterministic `LobbyInvariantError` and never repairs it.

## Start eligibility

Structural start eligibility contains `eligible` and every applicable blocker in this order:

1. `NOT_FOUR_PLAYERS`
2. `NOT_FOUR_SEATS_OCCUPIED`
3. `NOT_ALL_PLAYERS_READY`

Eligibility requires exactly four players, all four seats occupied, and every player ready. Connection status does not add a blocker. Host authorization is not structural and remains the responsibility of the later start-command handler.

## LobbySnapshotV1

The public snapshot is version `1`, phase `lobby`, and includes:

```text
roomId
roomCode
revision
selfPlayerId
hostPlayerId
settings
players
startEligibility
capabilities
```

Public settings expose only `startingLevel`, `turnTimer`, and `hasPassword`.

Each public player exposes only:

```text
playerId
displayName
seat
ready
connectionStatus
isHost
isSelf
```

The projector validates the complete room, rejects a viewer who is not a member, derives self/host flags, and sorts seated players by seat before unseated players by private `joinOrder`. The public parser cannot validate unseated ordering because it intentionally cannot see `joinOrder`; projector tests enforce that ordering.

Host capabilities are `canChangeSettings`, `canManageSeats`, and `canRemovePlayers` set to true, with `canStartMatch` matching structural eligibility. All capabilities are false for non-host viewers. These are informational and do not replace server authorization.

The snapshot parser verifies exact object shapes, identifiers, settings, players, duplicate IDs, duplicate derived display names, duplicate occupied seats, host/self membership and flags, structural eligibility, blocker ordering, and capability consistency.

## Acknowledgement foundations

A successful future accepted mutation contains:

```text
status: "ok"
commandId
roomRevision
snapshot
```

The success parser requires `roomRevision === snapshot.revision`.

Foundational error codes are:

```text
INVALID_PAYLOAD
ROOM_NOT_FOUND
NOT_ROOM_MEMBER
NOT_AUTHORIZED
STALE_REVISION
COMMAND_ID_CONFLICT
INVALID_LOBBY_STATE
INTERNAL_ERROR
```

An error contains exact required fields `status`, `code`, and a nonempty message of at most 160 characters. It may include a valid `commandId` when independently known and a valid `currentRevision` when known. It contains no raw exception or secret. Feature-specific errors will be introduced only with their corresponding commands.

## Explicit exclusions and later extension

M1-001 adds no create, join, leave, seat, ready, settings, removal, host-transfer, or start behavior. It adds no event name or Socket.IO registration, room repository, persistence, migration, password processing, reconnect credential, timers, mobile code, authentication, match state, or gameplay.

Later M1 tickets should compose command-specific exact payloads with the shared metadata, extend the foundational error set only for their own feature errors, use the authoritative invariant validator before and after accepted state transitions, increment revision only after acceptance, and project a fresh player-specific snapshot for acknowledgements.
