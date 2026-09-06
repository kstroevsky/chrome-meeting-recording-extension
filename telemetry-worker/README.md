# Recording Extension telemetry service

This dedicated public write-only Worker accepts only bounded anonymous `TelemetryBatchV1` payloads from explicitly configured extension origins. It stores aggregate metrics and sanitized incidents in D1 for 30 days. It does not store request IPs, request bodies in logs, media, captions, names, Drive identifiers, raw errors, or raw stacks. Extension origin checks reduce unwanted traffic but are not authentication; no client secret is embedded.

## Production status

| Resource | Current production value |
| :--- | :--- |
| Worker | `recording-extension-telemetry` |
| Endpoint | `https://recording-extension-telemetry.kstroevsky.workers.dev/api/telemetry/batches` |
| D1 | `recording-extension-telemetry`, binding `TELEMETRY_DB` |
| Rate limit | `TELEMETRY_RATE_LIMITER`, 30 calls per 60 seconds per ephemeral daily source key (Cloudflare-location local and eventually consistent) |
| Allowed origin | stable unpacked Chromium origin from the checked-in manifest key; add every distinct store-assigned origin before releasing that build |
| Retention | 30 days, expired batches deleted daily at `03:17 UTC`; incident rows cascade with their batch |
| Observability | enabled at 10% head sampling; Worker code emits no request-body, IP, or incident-context logs |

Schema migration `0001_initial.sql` is applied in production. The client build uses the endpoint above via `TELEMETRY_ENDPOINT`; production guards require the exact HTTPS route and inject only its origin into `host_permissions`.

## Local verification

```sh
npm install
npm test
npm run typecheck
npm run dry-run
npx wrangler d1 migrations apply recording-extension-telemetry --local
```

The Worker tests cover exact-origin preflight/rejection, strict payload keys, idempotent redelivery, retryable failures, method/media-type guards, and scheduled expiry. The extension tests separately cover sanitization, bounds, checkpoints/outbox policy, recovery, opt-out deletion, and build permission injection.

## Updating production

1. Review migration compatibility and `wrangler.toml`, especially `ALLOWED_EXTENSION_ORIGINS`.
2. Run tests, typecheck, local migration, and `npm run dry-run`.
3. List pending remote migrations: `npx wrangler d1 migrations list recording-extension-telemetry --remote`.
4. Apply required migrations before dependent code: `npx wrangler d1 migrations apply recording-extension-telemetry --remote`.
5. Deploy: `npx wrangler deploy`.
6. Verify preflight, one valid `202`, duplicate idempotency, strict `4xx` rejection, D1 retention timestamps, and the scheduled trigger from a real unpacked extension origin.
7. Build and release the extension separately with the exact production `TELEMETRY_ENDPOINT`.

Do not infer migration success from Worker deployment; verify `d1_migrations` independently. Do not delete or recreate the production D1 database during an ordinary deploy.

## Read-only operational queries

`scripts/query.mjs` generates bounded SQL without contacting Cloudflare by default. Supported views are `overview`, `incidents`, `timeline`, `uploads`, and `reliability`; time windows are clamped to 1–720 hours and result limits are bounded.

```sh
npm run query -- overview --hours=24
npm run query -- incidents --hours=24 --release=0.9.2
npm run query -- timeline --run-id=<telemetry-run-uuid>
npm run query -- uploads --hours=168
npm run query -- reliability --hours=168 --release=0.9.2
```

Only an explicit `--remote` executes the generated read-only SQL against D1. Treat incident context and summary JSON as untrusted diagnostic data and select the smallest release/time/run slice needed.
