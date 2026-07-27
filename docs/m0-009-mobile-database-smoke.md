# M0-009 mobile → server → database smoke verification

This infrastructure-only check proves that Expo Go on a physical iPhone can send a Socket.IO command to the public authoritative server, which writes and reads one fixed Supabase Postgres row before returning a structured acknowledgement.

## Migration setup

Migration: `apps/server/migrations/202607270001_create_infrastructure_smoke_probe.sql`

Table: `public.infrastructure_smoke_probe`

| Column             | PostgreSQL type | Constraint and meaning                                                                                  |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------- |
| `probe_key`        | `text`          | Primary key; check-constrained to `mobile-server-database-v1`                                           |
| `last_command_id`  | `uuid`          | Required mobile-generated command identifier                                                            |
| `last_probe_token` | `uuid`          | Required opaque mobile-generated probe token                                                            |
| `updated_at`       | `timestamptz`   | Required; defaults to database `statement_timestamp()` and is replaced by database time on every upsert |

The migration enables row-level security and creates no public policy. The server connects directly to Postgres; the mobile app does not use the Supabase Data API.

Apply the committed migration from the repository root using the same ignored `.env` and CA file as the server:

```sh
npm run server:migrate:smoke
```

`DATABASE_URL` and `DATABASE_CA_PATH` must be available in the shell or ignored root `.env`. The command uses verified TLS, logs no connection details, applies only the named committed SQL file, and verifies four columns plus RLS. The DDL is safe to run again: `CREATE TABLE IF NOT EXISTS` preserves the existing table and `ENABLE ROW LEVEL SECURITY` is idempotent.

Alternatively, a project administrator may copy the complete migration into the Supabase SQL Editor and run it there. Never paste database credentials or the CA certificate into SQL.

Verify the structure and RLS state:

```sql
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'infrastructure_smoke_probe'
ORDER BY ordinal_position;

SELECT relrowsecurity
FROM pg_class
WHERE oid = 'public.infrastructure_smoke_probe'::regclass;
```

After a successful smoke request, verify the retained row:

```sql
SELECT
  probe_key,
  last_command_id,
  last_probe_token,
  updated_at
FROM public.infrastructure_smoke_probe;

SELECT count(*) AS smoke_row_count
FROM public.infrastructure_smoke_probe;
```

Expected behavior is zero rows before the first run and exactly one row afterward. Every successful run upserts the fixed key and replaces the two identifiers and timestamp. Running the test repeatedly must leave `smoke_row_count = 1`.

A developer with configured private database access can verify two real transactional upsert/readback operations and one-row retention without printing identifiers:

```sh
npm run server:verify:database-smoke
```

This administrative verification is not part of CI and is not run during server startup.

## Mobile setup

The mobile app requires exactly one public setting:

```sh
EXPO_PUBLIC_SERVER_URL=https://guandan-server-hv6y.onrender.com
```

This is a public server origin, not a secret. From the repository root, start Expo with the value in the command environment:

```sh
EXPO_PUBLIC_SERVER_URL=https://guandan-server-hv6y.onrender.com npm run mobile:start
```

Then:

1. Connect the development computer and iPhone to a network that allows Expo Go connectivity.
2. Open Expo Go on the physical iPhone and scan the QR code printed by Expo.
3. Confirm the screen shows the configured host `guandan-server-hv6y.onrender.com`.
4. Press **Run Database Smoke Test**.
5. Expect the visible sequence: **Connecting** → **Waiting for database verification** → **Success**.
6. Allow up to 90 seconds for the connection because a free Render service may be cold. Database acknowledgement then has a 15-second bound.
7. On success, record the command ID, probe token, database update timestamp, and server completion timestamp shown on screen.

The button is disabled while a run is active, and each manual retry creates a fresh one-shot Socket.IO connection plus two fresh UUID v4 identifiers. A failed run returns to an enabled retry control.

Expected failures are displayed without stack traces:

- missing or malformed `EXPO_PUBLIC_SERVER_URL` → configuration failure;
- Socket.IO `connect_error` → connection failure;
- no connection within 90 seconds → connection timeout;
- no acknowledgement within 15 seconds → acknowledgement timeout;
- malformed or identifier-mismatched response → invalid acknowledgement;
- server/database failure → concise message plus the structured error code.

## Public deployment verification

Render deploys `main` through the root `render.yaml`. `autoDeployTrigger: checksPass` requires linked GitHub checks to pass before automatic deployment.

After merge and deployment:

1. Confirm the GitHub Actions **Quality gates / verify** job passed for the merged `main` commit.
2. Confirm Render deployed that commit.
3. Confirm liveness:

   ```sh
   curl --fail --silent --show-error https://guandan-server-hv6y.onrender.com/health
   ```

4. Confirm database readiness:

   ```sh
   curl --fail --silent --show-error https://guandan-server-hv6y.onrender.com/ready
   ```

5. Run the existing public health/readiness/Socket.IO scaffold check:

   ```sh
   npm run server:smoke -- https://guandan-server-hv6y.onrender.com
   ```

6. Run the new mobile database path from Expo Go as documented above.
7. Compare the mobile identifiers with the one Supabase row.
8. Run the mobile test a second time. Confirm the identifiers change, the retained row changes to the second values, and the table still has exactly one row.
9. Confirm Render logs show both command IDs with `status=ok databaseVerified=true` and contain no database URL, password, CA contents, or device credential.

A screenshot or copied success result from each mobile run should be retained as acceptance evidence. Physical-device acceptance remains a user-led step after technical review, merge, and deployment.

## Security statement

- The iPhone receives only `EXPO_PUBLIC_SERVER_URL`, a public HTTPS origin.
- The authoritative server owns all direct PostgreSQL access and transaction handling.
- Supabase credentials remain in ignored local configuration and Render private configuration.
- The Supabase CA certificate remains outside GitHub and is mounted as a Render secret file.
- Expo public values are bundled into the mobile app, so they contain no database URL, certificate path, password, token, or other privileged value.
- No Supabase client, Auth, Realtime, Data API policy, or client-side database access is introduced.
