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

Server development, type-check, test, and build commands compile the shared packages first so package-root imports resolve from a clean checkout. Restart the server development process after changing a shared package so it reloads the new compiled output.

## Quality checks

Run individual quality gates or the complete repository verification suite from the root:

```sh
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run expo:doctor
npm run verify
```

`format` is the only mutating quality command. `verify` runs formatting, lint, workspace type-checking, server tests, public package-import checks, the clean production build, and Expo Doctor without starting development servers. GitHub Actions runs `npm ci` followed by `npm run verify` for pull requests and branch pushes using Node.js 22.13.1.

## Dependency security

As of July 21, 2026, `npm audit` reports 13 moderate findings and no high or critical findings. The 13 package records derive from two transitive Expo SDK 54 tooling advisories: PostCSS through Metro configuration and `uuid` through Expo config plugins and `xcode`. The authoritative production server and shared packages have no audit findings.

The remaining findings are temporarily accepted because the repository already uses the latest compatible Expo SDK 54 packages, neither affected path is part of the normal native iPhone runtime, and remediation requires unsupported transitive overrides or an Expo major upgrade. Do not use `npm audit fix --force`. Reassess these findings when upgrading Expo, when Expo publishes compatible backports, or before adding web/CSS processing, custom config plugins, or native prebuild inputs. Any new high or critical finding requires blocking review.

## Zero-budget mobile testing

Early iPhone testing will use Expo Go on a physical device, avoiding paid native build infrastructure and Apple Developer Program costs while the app remains compatible with Expo Go.

See [the architecture summary](docs/architecture.md) for the planned system boundaries.
