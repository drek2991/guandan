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

The four application and package directories are managed as npm workspaces from the repository root. The mobile and authoritative server applications and both shared TypeScript packages contain their initial scaffolds; persistence and game logic have not been implemented.

## Runtime

Expo SDK 54 requires Node.js `20.19.4` or newer. This repository standardizes on Node.js `22.13.1`, pinned in `.nvmrc`, to keep local and automated environments consistent. The root package permits compatible Node.js 22 releases from 22.13.0 onward. With nvm:

```sh
nvm use
npm install
```

Start the Expo Go development server or run the mobile TypeScript check from the repository root:

```sh
npm run mobile:start
npm run mobile:typecheck
```

Verify and build the shared packages, or build all current production packages in dependency order:

```sh
npm run shared:typecheck
npm run shared:build
npm run build
```

Develop, verify, build, or run the authoritative server from the repository root:

```sh
npm run server:dev
npm run server:typecheck
npm run server:test
npm run server:build
npm run server:start
```

Server development, type-check, test, and build commands compile the shared packages first so package-root imports resolve from a clean checkout.

## Zero-budget mobile testing

Early iPhone testing will use Expo Go on a physical device, avoiding paid native build infrastructure and Apple Developer Program costs while the app remains compatible with Expo Go.

See [the architecture summary](docs/architecture.md) for the planned system boundaries.
