# Server

The authoritative Guandan server is built with Node.js, TypeScript, Express, and Socket.IO. This workspace provides the process, HTTP, real-time connection, database-smoke lifecycle scaffold, M1 lobby-state foundations, process-local authoritative create-room and join-room handlers, UUID channel membership, and individualized lobby snapshot delivery. The mobile app does not yet consume snapshots, and the server does not persist lobby state or implement cards and game logic.

Run commands from the repository root:

```sh
npm run server:dev
npm run server:typecheck
npm run server:test
npm run server:build
npm run server:start
npm run server:smoke -- https://your-server.example
```

- `server:dev` runs the TypeScript source with `tsx` and restarts when files change.
- `server:typecheck` validates strict TypeScript without emitting files.
- `server:test` runs deterministic HTTP and Socket.IO scaffold tests.
- `server:build` compiles production JavaScript into `apps/server/dist`.
- `server:start` runs the compiled JavaScript from `dist`.

The development and production-start commands optionally load `.env` from the repository root. Copy `.env.example` to `.env` only when local overrides are needed; shell and deployment variables take precedence over the file.

The server reads `PORT`, defaults to `3000`, and binds to `0.0.0.0` for local and deployment compatibility. Optional `NODE_ENV` values are `development`, `test`, and `production`. Invalid values fail before the server listens.

`DATABASE_URL` is required for actual startup and remains server-private. Use the Supabase Postgres **Session pooler** connection string. The server requires verified TLS connectivity. Set `DATABASE_CA_PATH` to the ignored Supabase CA certificate downloaded from Database Settings → SSL Configuration. The connection URL may omit `sslmode` or contain one `sslmode=require`; conflicting SSL settings are rejected. If the database password contains reserved URL characters, percent-encode the password component only. Never log or expose the connection string, hostname, username, password, or project reference through Expo public variables.

The server uses one bounded `pg` pool and verifies it with `SELECT 1` before opening the HTTP listener. Tests and CI inject fakes and require no database secret. M0-009 adds only the isolated `infrastructure_smoke_probe` table and its manual migration; no application persistence schema exists.

For a local connection smoke test, put the Session pooler URL only in the ignored root `.env`, build with `npm run server:build`, then start with `npm run server:start`. Run `npm run server:smoke -- --local http://127.0.0.1:3000`, send `SIGTERM`, and confirm clean shutdown without printing database details. The same command requires HTTPS for deployed targets.

See [the Render deployment runbook](../../docs/render-deployment.md) for the Stage A Blueprint, secret-file setup, remote verification, and free-tier cold-start behavior.

## Health and readiness

```text
GET /health
```

A live process returns HTTP 200 with:

```json
{
  "status": "healthy",
  "service": "guandan-server"
}
```

Database readiness is available at:

```text
GET /ready
```

It returns HTTP 200 with a stable ready response after a successful database query, or a sanitized HTTP 503 response when the database is unavailable. `/health` does not query the database.

Socket.IO retains the temporary `scaffold:ping` acknowledgement and adds the infrastructure-only `infrastructure:database-smoke` command from `@guandan/protocol`. The smoke command performs a transactional fixed-row upsert and exact readback through the authoritative server; it is not a lobby or gameplay protocol. Apply and verify its migration from the repository root with `npm run server:migrate:smoke`, and run configured real-database verification with `npm run server:verify:database-smoke`.

## Lobby state foundations

M1-001 adds pure server-internal lobby types, complete-state invariants, structural start eligibility, and player-specific `LobbySnapshotV1` projection under `src/lobby`. The internal model owns display-name uniqueness keys and stable join order while exposing only public settings and player fields through `@guandan/protocol`. Internal settings contain only starting level, turn timer, and `hasPassword`; no password material, socket ID, reconnect credential, persistence field, or gameplay state belongs to this model.

See [the lobby-state foundation contract](../../docs/m1-001-lobby-state-foundations.md) for ownership, invariants, ordering, revisions, capabilities, acknowledgement foundations, and explicit exclusions.

## Authoritative room creation

M1-002 registers only `lobby:create-room`. The process-local lobby runtime strictly parses and normalizes the command, generates cryptographic room/player identifiers and a bounded-collision room code, inserts a frozen invariant-valid revision-0 room into independent ID/code indexes, binds the requesting socket separately, and returns a player-specific snapshot. Successful command receipts make exact retries idempotent, while failures after insertion roll back room and binding state.

The handler logs no room code, display name, socket ID, or raw command and performs no database access or broadcast. See [the authoritative room-creation contract](../../docs/m1-002-authoritative-room-creation.md).

## Authoritative room joining

M1-003 registers `lobby:join-room`. The same process-local runtime looks up an exact code, rejects protected/full rooms and duplicate normalized names, appends one generated connected/unseated/non-ready non-host player, and atomically replaces the frozen room at revision +1. Create and join share global command-ID receipts, connection bindings, and deterministic idempotency; failed post-replacement work conditionally restores the exact previous room.

The authoritative join service performs no database or transport work and logs no room code, display name/key, socket ID, or raw payload. Password access, seats/readiness/settings mutation, leave/disconnect/reconnect handling, room deletion, persistence, mobile UI, and gameplay remain unimplemented. See [the authoritative room-join contract](../../docs/m1-003-authoritative-room-join.md).

## Player-specific snapshot delivery

M1-004 adds the canonical server-to-client `lobby:snapshot` event after successful create/join service results. The server completely prepares and validates one current `LobbySnapshotV1` per authoritative room binding, joins only the initiating socket to the UUID `roomId` channel, and emits each payload directly to its active bound socket. Socket.IO membership is transport metadata rather than recipient authority, and missing membership for other sockets is not silently repaired.

Exact receipt replay retries transport without changing room state. When the room has advanced beyond a stored acknowledgement, the original acknowledgement is returned before the current initiating snapshot so the latest state-bearing delivery remains final. Transport failures preserve room state, connection bindings, revisions, and successful receipts. The mobile app does not yet subscribe to this event. See [the lobby snapshot-delivery contract](../../docs/m1-004-lobby-snapshot-delivery.md).
