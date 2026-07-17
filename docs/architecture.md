# Architecture Summary

Guandan is planned as a small npm-workspaces monorepo with four independently scoped workspaces:

- `apps/mobile`: an iPhone-only React Native client built with Expo and tested during early development through Expo Go.
- `apps/server`: a Node.js and TypeScript authoritative game server using Express and Socket.IO, planned for deployment on Render.
- `packages/game-domain`: framework-independent, deterministic game rules and state transitions shared where appropriate.
- `packages/protocol`: shared client-server event names, payload types, and protocol contracts.

Supabase Postgres will provide persistence in a later milestone. The server will remain authoritative: clients submit player intent, while the server validates actions and advances game state. This milestone establishes only the repository boundaries; no application, persistence, networking, or game-logic implementation is included yet.
