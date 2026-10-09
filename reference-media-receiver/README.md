# External Media Storage Protocol V1 reference receiver

This package is a small, independent implementation of
[`docs/adr/0009-external-media-storage-protocol-v1.md`](../docs/adr/0009-external-media-storage-protocol-v1.md).
It exists to prove that the extension's external-media client interoperates with a receiver that does not import or depend on the extension's production code.

The receiver verifies signed integration test events with Standard Webhooks, advertises the generic media capability, persists transfer identity in a small JSON control store, and uses an S3-compatible provider for multipart upload, provider-authoritative resume, completion verification, and refreshable playback URLs.

## Run locally

Use Node.js 24 or newer and install the package dependencies:

```sh
npm ci --prefix reference-media-receiver
npm test --prefix reference-media-receiver
```

The CLI requires TLS and a private S3-compatible bucket:

```text
TLS_KEY_PATH
TLS_CERT_PATH
WEBHOOK_SECRET
MEDIA_BEARER
S3_ENDPOINT
S3_BUCKET
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

Optional settings are `HOST`, `PORT`, `PUBLIC_ORIGIN`, `STATE_PATH`, `S3_REGION`,
`S3_FORCE_PATH_STYLE`, `S3_UPLOAD_ORIGIN`, `UPLOAD_URL_TTL_SECONDS`,
`PLAYBACK_URL_TTL_SECONDS`, `UPLOAD_ATTEMPT_TTL_MS`, `PART_SIZE_BYTES`,
`MAX_CONCURRENCY`, `MAX_ARTIFACT_BYTES`, and `CLEANUP_ON_EXIT`.

For Cloudflare R2, use the account S3 endpoint, region `auto`, and
`S3_FORCE_PATH_STYLE=false`. The bucket must allow browser `PUT`, `GET`, and
`HEAD` requests from the extension's execution context and expose the `ETag`
response header so multipart UploadPart responses can be verified.

## Scope

The JSON state store intentionally favors readability and deterministic crash
recovery over horizontal scalability. It serializes atomic rewrites and is
sufficient for protocol conformance and integration testing, but it is not a
production multi-process control-plane database. Storage credentials are read
only from the process environment and are never written to the state file.

The browser conformance suite lives in `tests/e2e/integration-media-reference.spec.ts`.
It exercises the real extension against this receiver and a real R2/S3 bucket.
