# Server

The authoritative Guandan server is built with Node.js, TypeScript, Express, and Socket.IO. This workspace currently provides only the process, HTTP, real-time connection, and lifecycle scaffold; rooms, players, cards, persistence, and game logic are not implemented.

Run commands from the repository root:

```sh
npm run server:dev
npm run server:typecheck
npm run server:test
npm run server:build
npm run server:start
```

- `server:dev` runs the TypeScript source with `tsx` and restarts when files change.
- `server:typecheck` validates strict TypeScript without emitting files.
- `server:test` runs deterministic HTTP and Socket.IO scaffold tests.
- `server:build` compiles production JavaScript into `apps/server/dist`.
- `server:start` runs the compiled JavaScript from `dist`.

The development and production-start commands optionally load `.env` from the repository root. Copy `.env.example` to `.env` only when local overrides are needed; shell and deployment variables take precedence over the file.

The server reads `PORT`, defaults to `3000`, and binds to `0.0.0.0` for local and deployment compatibility. Optional `NODE_ENV` values are `development`, `test`, and `production`. Invalid values fail before the server listens.

Private service credentials will belong only on this authoritative server. They must not be logged or exposed through Expo public variables. Supabase credentials are not configured yet.

## Health check

```text
GET /health
```

A healthy process returns HTTP 200 with:

```json
{
  "status": "healthy",
  "service": "guandan-server"
}
```

Socket.IO currently exposes only the temporary `scaffold:ping` acknowledgement from `@guandan/protocol` to verify shared-package connectivity. It will be replaced by the gameplay protocol in a later milestone.
