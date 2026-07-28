# Server

The authoritative Guandan server is built with Node.js, TypeScript, Express, and Socket.IO. This workspace currently provides only the process, HTTP, real-time connection, and lifecycle scaffold; rooms, players, cards, persistence, and game logic are not implemented.

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
