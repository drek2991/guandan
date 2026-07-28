# M0 exit report

## Milestone outcome

M0 passed technical exit verification on July 28, 2026. The repository foundation, authoritative server, shared package boundaries, Supabase connection, Render deployment, public HTTP and Socket.IO transports, and physical iPhone database path are accepted. M1 lobby development is authorized to begin after Technical Lead confirmation.

## Accepted tickets

- M0-000 — Repository creation
- M0-001 — Monorepo scaffold
- M0-002 — Expo mobile scaffold
- M0-003 — Authoritative server scaffold
- M0-004 — Shared domain and protocol packages
- M0-005 — Quality gates
- M0-006 — Environment and secret boundary
- M0-007 — Supabase connection
- M0-008 — Render deployment
- M0-009 — Mobile → Server → Database end-to-end verification
- M0-010 — Final M0 acceptance and milestone exit gate

## Final repository state

The accepted implementation baseline was `6170b8001b0030dccadb68296cb0d1f3727f8930` on `main`. Local and remote `main` matched and the working tree was clean before this exit report was prepared. A clean install passed the complete repository verification suite with 125 tests and Expo Doctor 18/18. Shared protocol JavaScript and declaration outputs were produced successfully.

## Deployment state

Public service: `https://guandan-server-hv6y.onrender.com`

- GitHub Actions `Quality gates` completed successfully for the accepted baseline.
- Render reported a successful deployment of that baseline.
- `/health` returned HTTP 200 with `healthy`.
- `/ready` returned HTTP 200 with `ready`.
- The official public smoke command verified polling and WebSocket Socket.IO connections sequentially.
- Both transports returned the exact `scaffold:ping` acknowledgement and disconnected cleanly.
- The server reached Supabase through verified TLS and completed two real transactional writes/readbacks.
- The fixed key remained `mobile-server-database-v1`, and exactly one retained smoke row matched the second verification operation.

## Physical-device state

The user confirmed M0-009 on a physical iPhone through Expo Go:

- Run 1 displayed the configured public Render host and reached Success.
- Run 1 returned a command ID, probe token, and database timestamp that matched the Supabase row; row count was one.
- Run 2 generated a distinct command ID and probe token and reached Success.
- Supabase still contained exactly one row after Run 2.
- The retained row matched Run 2 and replaced Run 1 values.

No additional iPhone run was required for M0-010. This report does not claim that screenshots were preserved.

## Security boundary

- Real `.env` files and CA certificates remain ignored.
- No database URL, password, certificate content, or privileged Supabase value is tracked.
- Expo receives only the public `EXPO_PUBLIC_SERVER_URL` origin.
- The mobile client has no direct PostgreSQL or Supabase Data API access.
- The authoritative server owns validation, Socket.IO command handling, transactions, persistence, health, and readiness.
- Supabase row-level security is enabled on the infrastructure probe with zero public policies.
- Render keeps database configuration private and mounts the CA through a deployment-only secret-file path.
- Tracked-file secret checks passed without printing private configuration.

## Known limitations

1. Render free services may sleep after inactivity.
2. The first public request may experience cold-start delay.
3. Expo Go development requires Metro to be reachable from the physical iPhone.
4. LAN Expo testing may be disrupted by VPNs, firewalls, guest Wi-Fi, or client isolation.
5. Clean mobile development requires shared packages to be compiled before Metro resolves package exports.
6. M0 uses one isolated fixed-row infrastructure table, not a production persistence schema.
7. M0 does not provide lobby, gameplay, reconnect, or durable room behavior.
8. Initial operational capacity remains one active room; future room state must be isolated by room identity.
9. No keep-alive service or external Render pinger is approved.
10. Dependency audit advisories are not automatically addressed through forced major upgrades.

These limitations are accepted and do not block M0 exit.

## M1 authorization

**PASS — Authorize M1 lobby development.**

M1 may add its approved lobby slice only after formal Technical Lead acceptance. It must preserve server authority, shared protocol ownership, room isolation, secret boundaries, and the existing M0 quality gates.
