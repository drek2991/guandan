# M1-004 Lobby Snapshot Delivery

M1-004 adds the process-local transport step after the accepted synchronous `lobby:create-room` and `lobby:join-room` services commit authoritative lobby state. It does not change command validation, mutation, rollback, receipt, or acknowledgement contracts.

## Canonical event

The server-to-client event is:

```text
lobby:snapshot
```

Its single payload is the existing player-specific `LobbySnapshotV1`. The shared protocol package remains environment-independent and uses `parseLobbySnapshotV1` as the only runtime payload validator. The event has no envelope and no client acknowledgement.

`LobbySnapshotV1` continues to include the public room code already defined by M1-001. It excludes display-name keys, join order, socket IDs, command IDs, password material, and all other internal state.

## Successful command sequence

A newly accepted create or join follows this order:

```text
authoritative service success
→ prepare and validate the complete delivery plan
→ initiating socket joins the roomId Socket.IO channel
→ queue one individualized snapshot per active authoritative binding
→ return the command acknowledgement
```

Planning projects and validates every snapshot before channel membership or any emission. A planning failure therefore cannot add channel membership or partially update recipients.

The Socket.IO channel name is the authoritative UUID-v4 `roomId`, never the human-facing room code. Only the initiating socket joins the channel. Delivering a snapshot to another active socket does not silently repair that socket's missing channel membership.

## Recipient authority and individual delivery

Recipients are selected from the intersection of:

1. authoritative process-local connection bindings for the room; and
2. the Socket.IO server's currently active, connected socket collection.

Socket.IO room membership is transport metadata and is never used as recipient authority. Each active socket receives only the snapshot projected for its bound player. The server does not use a room-wide emitter for player-specific payloads.

Bindings are ordered by the authoritative public player order: seated players by seat, then unseated players by join order. Missing or disconnected non-initiating sockets are skipped without removing their binding or changing authoritative connection status. One non-initiating emission failure does not prevent other recipients from being attempted.

For this milestone, an initiating emission succeeds when the same socket remains present in the active collection, remains connected, and calling `emit` does not throw. This guarantees server-side queuing only; client receipt or rendering is not asserted and no client snapshot acknowledgement exists.

## Exact replay and revision ordering

Successful command receipts remain exact and immutable. An exact replay never creates a replacement acknowledgement.

When the stored acknowledgement and current delivery plan have the same revision, the initiating snapshot is queued before the acknowledgement callback.

When later accepted commands have advanced the room, an exact replay uses this order for the initiator:

```text
return the original stored acknowledgement
→ immediately queue the current lobby:snapshot
```

This keeps the final state-bearing delivery at the current authoritative revision while preserving exact command idempotency. Other bound recipients receive current individualized snapshots as part of the replay transport attempt.

A plan revision lower than the stored acknowledgement revision is rejected as an internal transport error. The plan must also match the acknowledgement room and contain exactly one initiating delivery for the initiating socket and acknowledged self player.

## Committed-state failure and recovery

Post-success transport failure returns the command-specific sanitized `INTERNAL_ERROR` acknowledgement for that attempt. It does not:

- roll back or delete the room;
- remove a player;
- decrement the room revision;
- unbind the authoritative connection;
- delete or replace the successful receipt; or
- join other players to the Socket.IO channel.

The only transport recovery path is an exact retry of the original successful command ID and payload from the same socket. The authoritative service returns its original stored success receipt and transport coordination runs again against the current room. A new command ID from that already-bound socket still returns `ALREADY_IN_ROOM`.

## Logging and privacy

Operational evidence is limited to command kind and ID, room ID, current revision, recipient/emitted/skipped/failed counts, status, and transport phase. Logs and public errors exclude room codes, display names and keys, join orders, socket IDs, passwords, raw payloads, raw room state, exception details, and database metadata.

## Process-local limitations and exclusions

The repository, connection registry, command receipts, delivery planner, Socket.IO channel metadata, and active socket collection are process-local. M1-004 adds no cross-instance adapter, Redis, persistence, lobby database table, snapshot persistence, or reconnection mechanism.

The mobile application does not yet subscribe to `lobby:snapshot`. This ticket also excludes mobile lobby UI, room links, passwords, seats, readiness, settings mutation, leave/disconnect cleanup, connection-status mutation, host transfer, player removal, room deletion, empty-room cleanup, reconnect credentials, client snapshot acknowledgements, match start, gameplay, cards, and rules logic.

Future tickets may add mobile subscription and explicit disconnect/reconnection behavior without changing the authoritative create/join mutation boundary established here.
