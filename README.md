# Guandan

Guandan is currently in **Milestone 0**, establishing the repository foundation for a future mobile card game.

## Planned components

- **Mobile client:** an iPhone-only React Native application built with Expo.
- **Authoritative server:** a Node.js and TypeScript service using Express and Socket.IO.
- **Game domain:** shared deterministic game rules and state transitions.
- **Protocol:** shared client-server messages and TypeScript contracts.
- **Persistence and deployment:** Supabase Postgres and Render, introduced in later milestones.

## Repository layout

```text
apps/
  mobile/
  server/
packages/
  game-domain/
  protocol/
docs/
```

The four application and package directories are managed as npm workspaces from the repository root. They contain placeholders only during this milestone; the mobile app, server, persistence, and game logic have not been scaffolded.

## Runtime

Use Node.js `22.13.1`, pinned in `.nvmrc`. This satisfies the current Expo toolchain's Node.js 22.13.x-or-newer requirement and keeps local and automated environments aligned. The root package permits compatible Node.js 22 releases from 22.13.0 onward. With nvm:

```sh
nvm use
npm install
```

## Zero-budget mobile testing

Early iPhone testing will use Expo Go on a physical device, avoiding paid native build infrastructure and Apple Developer Program costs while the app remains compatible with Expo Go.

See [the architecture summary](docs/architecture.md) for the planned system boundaries.
