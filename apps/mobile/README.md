# Mobile

Minimal iPhone client built with Expo SDK 54, React Native, TypeScript, and Expo Router. It uses Expo's managed workflow and runs in Expo Go without a custom development client.

## M0-009 infrastructure smoke screen

The current screen is a narrow infrastructure verification surface. It sends the shared `infrastructure:database-smoke` command to the authoritative server and displays success only after the server confirms a transactional Supabase Postgres upsert and exact readback. It does not connect directly to Supabase or include lobby, identity, authentication, or gameplay behavior.

From the repository root, install dependencies and start Metro for the deployed server:

```sh
npm install
npm run shared:build
EXPO_PUBLIC_SERVER_URL=https://guandan-server-hv6y.onrender.com npm run mobile:start
```

A clean checkout must compile the shared packages before Metro resolves their package exports. Rebuild and restart Metro after changing a shared package.

Open Expo Go on a physical iPhone and scan the development-server QR code. Press **Run Database Smoke Test** and allow for a possible Render free-tier cold start. The visible states are Idle, Connecting, Waiting for database verification, Success, and Failure. While a run is active, the button and the pure run lock suppress duplicate submissions. Each accepted run uses Expo SDK 54's compatible `expo-crypto` UUID-v4 generator, opens one non-reconnecting connection, and disconnects after a bounded result. Failure permits a manual retry.

`EXPO_PUBLIC_SERVER_URL` must be an HTTP or HTTPS origin with no credentials, path, query, or fragment. Expo statically includes `EXPO_PUBLIC_` values in the application bundle, so they are public. Never put `DATABASE_URL`, CA paths, Supabase credentials, service-role keys, passwords, signing secrets, device credentials, or reconnect credentials in a mobile environment value.

Run mobile validation from the root:

```sh
npm run mobile:typecheck
npm run mobile:test
npm run expo:doctor
```

See [`docs/m0-009-mobile-database-smoke.md`](../../docs/m0-009-mobile-database-smoke.md) for migration application, public deployment checks, exact iPhone steps, Supabase comparison, and second-run retention verification.
