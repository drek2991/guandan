# M1-005 Authoritative Self Seat Selection

M1-005 adds the first authoritative lobby mutation for a player already bound to a process-local room. A player can select, move, clear, or repeat only their own seat through the synchronous `lobby:set-seat` command. It builds on the immutable repository transitions from M1-003 and the individualized snapshot transport from M1-004.

## Canonical command and acknowledgement

The client-to-server event is:

```text
lobby:set-seat
```

The command has exactly three fields:

```text
commandId
knownRevision
seat
```

`commandId` is a canonical lowercase UUID-v4, `knownRevision` is a nonnegative safe integer, and `seat` is exactly `0`, `1`, `2`, `3`, or `null`. `null` clears the acting player's seat. Missing or additional fields are rejected, including client-supplied room IDs, player IDs, readiness, host authority, or settings.

A success uses the existing lobby-mutation acknowledgement:

```text
status: "ok"
commandId
roomRevision
snapshot
```

The snapshot is the existing player-specific `LobbySnapshotV1`. The set-seat command permits only these errors:

```text
INVALID_PAYLOAD
NOT_ROOM_MEMBER
STALE_REVISION
COMMAND_ID_CONFLICT
SEAT_TAKEN
INVALID_LOBBY_STATE
INTERNAL_ERROR
```

A parsed command ID is retained on post-parse errors. `STALE_REVISION` alone carries the required `currentRevision`; other errors reject that field. Public messages are bounded and sanitized.

## Actor authority

The initiating Socket.IO connection supplies no player or room authority in its payload. The synchronous service resolves the authoritative connection binding by socket ID, loads that binding's room, and finds exactly one player by the binding's player ID. Host status grants no ability to assign, move, clear, swap, or displace another player.

An unbound socket receives `NOT_ROOM_MEMBER`. A binding that refers to a missing room or missing player is an internal inconsistency and receives `INTERNAL_ERROR` without internal state or exception detail.

## Revision and seat precedence

A new command is evaluated in this order:

```text
parse complete command
→ resolve global receipt
→ resolve socket binding
→ load and validate room
→ confirm the bound player
→ compare knownRevision
→ resolve same-seat no-op
→ check target occupancy
→ construct and validate next room
→ replace repository state
→ project and validate success
→ store receipt
```

The exact current revision is required even for a same-seat no-op. A stale request receives `STALE_REVISION` before target-seat occupancy is considered. A current request for another player's occupied seat receives `SEAT_TAKEN`; no player is moved, cleared, swapped, or displaced, and no state or receipt is created.

## Actual changes and readiness

An actual select, move, or clear operation replaces the complete immutable room exactly once at revision `current + 1`. It changes only:

- the room revision;
- the bound player's seat; and
- the bound player's readiness, which is reset to `false`.

All other room values, player values, and internal player-array order remain unchanged. Readiness can only be reset by this command; M1-005 does not add a command that makes a player ready.

## Same-seat no-op

A request for the player's current seat succeeds after exact revision validation, including `null → null`. It does not replace repository state, create rollback state, increment the revision, or alter any player field. In particular, a ready player repeating the same seat remains ready.

The service still projects and validates the current player-specific snapshot, stores a successful immutable receipt, and runs normal snapshot transport.

## Narrow repository replacement

Seat selection uses a dedicated repository transition rather than a general updater. Its input includes the room ID, expected revision, acting player ID, expected current seat, requested next seat, and complete next room.

The repository independently rejects stale revisions, overflow, no-op replacement, missing actors, old/new seat mismatches, room identity/code changes, phase/host/settings changes, player additions/removals/reordering, non-acting-player changes, and acting-player changes outside seat/readiness. It also validates complete lobby invariants, including seat uniqueness, before taking ownership.

Accepted rooms are deep-cloned and recursively frozen. Room count and room-code indexing remain stable, and the replacement returns both the exact prior repository-owned room reference and the new repository-owned reference.

## Exact rollback

If success projection, acknowledgement validation, or receipt insertion fails after an actual replacement, the seat service attempts a conditional rollback. Rollback requires:

- the exact current replacement object;
- its operation kind (`set-seat` rather than `join-room`);
- the expected replacement revision;
- room and code-index continuity; and
- the exact prior repository-owned object reference.

A successful rollback restores that exact object without cloning and consumes its rollback record. Reconstructed, reused, cross-operation, stale, or newer-state rollback attempts are rejected. If rollback cannot prove and restore the expected state, the service returns sanitized `INTERNAL_ERROR` and does not overwrite newer state.

Same-seat no-ops never create rollback records.

## Global command receipts and replay

Create-room, join-room, and set-seat share one process-local command-ID receipt map. A successful set-seat receipt freezes a canonical command copy and the complete nested success snapshot.

An exact replay requires the same socket, command kind, command ID, known revision, and requested seat. It returns the exact stored logical success before reevaluating socket binding, room state, revision, or occupancy. Any changed payload, different socket, or cross-kind use of the command ID receives `COMMAND_ID_CONFLICT`.

No failed command stores a success receipt.

## Individualized snapshot transport

Every successful set-seat result, including no-op and exact replay, enters the accepted M1-004 transport coordinator. The coordinator first plans and validates the complete delivery set from authoritative room bindings, then joins only the initiating socket to the UUID `roomId` channel and emits one player-specific snapshot directly to each active bound socket. Socket.IO room membership is transport metadata, not recipient authority.

For a current acknowledgement revision, the initiating snapshot is queued before the command acknowledgement. If exact replay returns an older stored acknowledgement after the room has advanced, ordering is:

```text
original stored acknowledgement
→ current authoritative lobby:snapshot
```

A transport failure after authoritative success does not roll back the seat, readiness, revision, binding, or receipt. Retrying the exact command reruns transport against current authoritative state.

## Logging and privacy

Operational logging is limited to sanitized command and transport evidence such as command kind/ID, room ID, revision, phase, and aggregate recipient results. Logs and public errors exclude raw payloads, room codes, display names and normalized keys, socket IDs, join order, full room state, password material, database metadata, and exception detail.

## Process-local limitations and exclusions

The lobby repository, connection bindings, receipts, snapshot plans, active sockets, and Socket.IO channel metadata remain process-local. M1-005 adds no persistence, Redis adapter, or cross-instance synchronization.

This milestone does not implement mobile seat or lobby UI; host management of another player's seat; swapping or displacement; ready-to-true behavior; host settings mutation; player removal; leave/disconnect cleanup; reconnect identity; connection-status mutation; host transfer; room deletion; password access; room links; match start; dealing; cards; gameplay; lobby database tables; authentication; or accounts.
