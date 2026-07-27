# Render deployment

M0-008 deploys the authoritative server as one free Render Web Service. Stage A adds this repeatable configuration; the real service is provisioned and verified only after the branch is reviewed and merged into `main`.

## Blueprint configuration

The root [`render.yaml`](../render.yaml) defines `guandan-server` as a native Node Web Service in Render's Ohio region on the free plan, with one instance and Blueprint preview environments disabled. It builds from the monorepo root because the server depends on the root npm workspace, root lockfile, shared TypeScript configuration, and `@guandan/protocol`.

Render runs:

```sh
npm ci && npm run server:build
npm run server:start
```

The repository's `.nvmrc` pins Node.js 22.13.1. Do not add `NODE_VERSION`, another runtime file, a Docker image, or a workspace-specific runtime override. The root `.npmrc` keeps the TypeScript build tools available when Render sets `NODE_ENV=production`.

The service uses `/ready` as its HTTP health check because the authoritative server is operationally usable only when PostgreSQL is available. `/health` remains a process-liveness endpoint and never queries the database. Render supplies `PORT`; it must not be configured manually.

Automatic deployments track `main` and use `autoDeployTrigger: checksPass`, so Render waits for linked GitHub checks. The existing `Quality gates / verify` workflow runs for pushes to `main`. Render treats successful, neutral, and skipped GitHub check conclusions as passing and does not deploy when no checks are detected or a check fails. A 60-second shutdown allowance gives the existing `SIGTERM` handler time to close Socket.IO, HTTP, and the PostgreSQL pool.

Render assigns a public HTTPS subdomain. The Blueprint explicitly enables it but does not hard-code the eventual hostname.

## Private configuration

The Blueprint sets these non-secret values:

```text
NODE_ENV=production
DATABASE_CA_PATH=/etc/secrets/supabase-ca.crt
```

`DATABASE_URL` is declared with `sync: false`, so Render prompts for it during initial Blueprint creation. Supply the Supabase Postgres **Session pooler** URL in Render only. Never paste it into documentation, GitHub, logs, screenshots, tests, or chat.

Upload the Supabase CA certificate in the Web Service's Environment section as a secret file named exactly:

```text
supabase-ca.crt
```

Render mounts the file at `/etc/secrets/supabase-ca.crt`. Do not upload the root `.env`, commit the local certificate, embed it in source code, or download it during every startup. Later Blueprint synchronizations do not replace a `sync: false` value; rotate it in the Render dashboard.

## Initial Render setup

Perform these steps only after Stage A is reviewed, merged into `main`, and the merged commit's GitHub quality checks succeed:

1. Sign in to Render and connect `drek2991/guandan` through the GitHub integration.
2. Create a Blueprint from the repository's root `render.yaml` on `main`.
3. Supply `DATABASE_URL` when prompted without sharing it outside Render.
4. Open the created `guandan-server` Web Service's Environment section.
5. Upload `supabase-ca.crt` as a secret file.
6. Confirm `DATABASE_CA_PATH=/etc/secrets/supabase-ca.crt`.
7. Trigger or retry deployment after the secret file is available.
8. Confirm deployment logs resolve Node.js 22.13.1, install dependencies, build shared packages before the server, start compiled JavaScript, and complete the startup database check. Review logs without copying private database or certificate details.
9. Record the public Render HTTPS URL for Stage B verification.

Do not add a GitHub deploy hook, Render API key, deployment workflow, uptime monitor, or keep-alive traffic.

## Smoke verification

The smoke command accepts an explicit base URL and checks the public contract with finite timeouts:

```sh
npm run server:smoke -- https://your-render-hostname.onrender.com
```

It requires HTTPS, verifies exact HTTP 200 responses from `/health` and `/ready`, connects through Socket.IO, emits `scaffold:ping`, checks the `{ "status": "ok" }` acknowledgement, and disconnects. Failure output identifies the failed stage without printing arbitrary response bodies or infrastructure details.

For a local compiled server only, explicitly permit loopback HTTP:

```sh
npm run server:smoke -- --local http://127.0.0.1:3000
```

`--local` accepts only loopback hosts and does not disable HTTPS certificate verification.

## Local production-path verification

Before Stage A is pushed:

1. Confirm the ignored root `.env` contains the real Session pooler URL and a valid `DATABASE_CA_PATH` pointing to the ignored local certificate. Never print either file.
2. Remove generated output and run:

   ```sh
   npm ci
   npm run verify
   npm run server:build
   ```

3. Start the compiled server from the repository root with the ignored environment:

   ```sh
   node --env-file-if-exists=.env apps/server/dist/index.js
   ```

4. Run the local smoke command against its loopback address.
5. Send `SIGTERM`, wait for a zero exit status, and confirm no process remains.
6. Confirm startup and shutdown logs contain no database URL, password, hostname, username, project identifier, or certificate contents.

## Free-instance behavior

Render free Web Services spin down after inactivity. A later request can take approximately a minute to wake the service, although actual duration varies. Stage B must let the instance become idle, request `/health`, record the approximate observed wake-up time, then verify `/ready` and Socket.IO again. No artificial ping, cron job, external uptime service, or keep-alive traffic should prevent spin-down.

Deployments, maintenance, and sleep can disconnect Socket.IO clients. Reconnection behavior belongs to later client work; M0-008 verifies only the temporary scaffold acknowledgement. The mobile application is not connected to this service in this ticket, and no tables, migrations, rooms, players, cards, or game persistence are introduced.
