# ADR-0008 network compatibility

This table is evidence, not a support promise.

Measured 2026-09-24 on macOS 15.8 (24H23), arm64, Chrome for Testing
148.0.7778.96. The automated "granted" column uses an equivalent static
scheme+host permission so transport behavior can be measured without a native
Chrome prompt.

| Target | Before host access | With scheme+host access | After browser restart | Runtime request / LNA | Notes |
| --- | --- | --- | --- | --- | --- |
| Public HTTPS (`example.com`) | Page + worker blocked | Page + worker reached server (HTTP 405 to POST) | Same | Manual prompt path still to verify | Proves arbitrary HTTPS needs host access when receiver does not opt into CORS |
| `http://localhost:<port>` | Page + worker blocked | Page + worker HTTP 204 | Same | Manual prompt path still to verify | HTTP remains provisional |
| `http://127.0.0.1:<port>` | Page + worker blocked | Page + worker HTTP 204 | Same | Native `chrome.permissions.request` prompt surfaced; automation could not accept it | HTTP remains provisional |
| RFC1918 private IPv4 | Page + worker blocked | Page + worker HTTP 204 | Same | Manual permission/LNA flow still to verify | Tested against `192.168.178.71`; HTTP remains provisional |
| `.local` host | Not measured | Not measured | Not measured | Not measured | Current candidate `MacBookPro.fritz.box.local` did not resolve |
| Private DNS | Not measured | Not measured | Not measured | Not measured | Supply a reachable test URL with `--private-dns` |
| Trusted local HTTPS | Not measured | Not measured | Not measured | Not measured | Supply a trusted endpoint with `--trusted-https` |
| Self-signed local HTTPS | Blocked | Blocked | Blocked | N/A | Host access does not bypass TLS validation |

No extra LNA failure appeared when static host access was present for the
RFC1918 target on this browser/OS combination. That does **not** establish the
runtime permission UX: the user-gesture request produced native Chrome UI that
the automated run could not accept.

Chrome match patterns do not carry a port, so the narrowest permission for
`http://127.0.0.1:8799/events` is `http://127.0.0.1/*`. Endpoint validation
must still retain the configured port even though permission scope is
scheme+host wide.

Production currently declares optional arbitrary HTTPS host access only.
HTTP/LAN permissions are intentionally absent until this matrix and the runtime
permission-request flow are understood.
