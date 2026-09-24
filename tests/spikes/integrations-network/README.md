# Integration network compatibility spike

ADR-0008 Phase 0 requires measured extension-network behavior before the product
claims localhost or LAN webhook support. This throwaway spike probes both an
extension page and an extension service worker using the same hardened POST
shape planned for webhook delivery.

Run:

```bash
node tests/spikes/integrations-network/run.mjs
```

Optional targets:

```bash
node tests/spikes/integrations-network/run.mjs \
  --private-dns http://internal-name.example:8799/events \
  --trusted-https https://trusted-lan-host.example:8799/events
```

The automated run compares no host access with an equivalent exact
scheme+host grant and repeats the granted case after a browser restart. Chrome
match patterns do not encode ports, so the narrowest permission for
`http://127.0.0.1:8799/events` is `http://127.0.0.1/*`.

The generated receiver intentionally sends no CORS headers. A successful fetch
therefore demonstrates extension host access rather than an endpoint that
happens to opt into browser CORS.

The static-grant comparison isolates transport/LNA behavior. Before shipping
localhost/LAN support, the same targets must also be checked through the real
`chrome.permissions.request()` user-gesture flow, including permission
retention across browser restart. Record those results in
`compatibility.md`; do not infer them from this automated static-grant run.

The runner also attempts that real request for loopback. In automated Chromium
the request currently reaches a native permission prompt that Playwright cannot
accept, and is reported as `native-prompt-unresolved`. That is a useful result:
the product settings UI must own the request from an explicit user gesture, and
Phase 0 still needs one manual acceptance/restart pass before HTTP/LAN can be
advertised.
