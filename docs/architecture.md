# Architecture Summary

Guandan is planned as a small npm-workspaces monorepo with four independently scoped workspaces:

- `apps/mobile`: an iPhone-only React Native client built with Expo and tested during early development through Expo Go.
- `apps/server`: a Node.js and TypeScript authoritative game server using Express and Socket.IO, planned for deployment on Render.
- `packages/game-domain`: framework-independent, deterministic game rules and state transitions shared where appropriate.
- `packages/protocol`: shared client-server event names, payload types, and protocol contracts.

The server remains authoritative: clients submit intent, while the server validates commands and owns all direct database access. M0 now includes deployed HTTP and Socket.IO scaffolding plus one isolated fixed-row Supabase infrastructure probe; it does not include application persistence, rooms, players, lobby behavior, gameplay, or game-rule implementation.
