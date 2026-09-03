# Drive playback spike (throwaway)

ADR-0006 step 1, half 1. Three scripts, in the order you should run them.

| | Script | Needs a Google account? | Answers |
|---|---|---|---|
| 0 | `selftest.mjs` | no | Does the mechanism work at all — DNR-authorized `<video>`, tab-scoped rule, Range seeking, token isolation? |
| 1 | `probe.mjs` | yes (token) | Does `files.get?alt=media` honour `Range`, and does it redirect off `www.googleapis.com`? |
| 2 | `run.mjs` | yes (token) | Does a real recording actually seek without dragging the byte prefix, through the DNR rule? |

Delete the whole directory once ADR-0006 is Accepted.

## 0. Self-test — no account needed

```bash
node tests/spikes/drive-playback/selftest.mjs --seconds 120
```

Encodes a seekable WebM with ffmpeg, serves it from a loopback origin that
**401s without a bearer token**, and plays it in the spike extension. Playback
succeeding *is* the assertion that the DNR rule attached the header.

Result on Chromium 148 (2026-09-03): all green. 0.1 MB read for metadata; a seek
to 80% of a 25.8 MB file transferred 4.5 MB against a 20.7 MB prefix; ranges
`bytes=0-`, `bytes=27099136-` (Cues), then a binary search into position.

## 1. Getting a token

The spike does not run its own OAuth. Mint a token from the extension you
already have installed in your main Chrome — its own client id, its existing
consent, nothing new granted:

1. `chrome://extensions` → the extension → **service worker**
2. In that console (top-level `await` works there):

```js
const r = await new Promise(res => chrome.identity.getAuthToken({ interactive: true }, res));
const token = typeof r === 'string' ? r : r?.token;   // Chrome 128+ returns an object
console.log(token);
```

3. Right-click the logged string → **Copy string contents**. (`copy(token)` also
   works, but only as its own console line — `copy` is a DevTools helper that
   does not exist inside the async callback, which is why the obvious one-liner
   `getAuthToken({interactive:true}, t => copy(t))` fails with
   `ReferenceError: copy is not defined`.)

Then `export DRIVE_TOKEN='<paste>'`. Tokens are short-lived; re-mint as needed.

Note the unwrap: Chrome 128+ resolves `getAuthToken` to `{ token, grantedScopes }`
rather than a bare string. The extension's own `platform/chrome/identity.ts`
handles both shapes; so does the snippet above.

## 2. The Drive HTTP question

```bash
node tests/spikes/drive-playback/probe.mjs --token "$DRIVE_TOKEN"
```

Walks the redirect chain by hand, sending `Authorization` on the first hop and
**deliberately dropping it afterwards** — whether the redirect target still
demands the header is exactly what decides the DNR rule's scope, and ADR-0006
refuses to guess it. Picks the largest app-created `.webm`/`.mp4` unless you
pass `--file-id`.

## 3. Real playback and seeking

```bash
node tests/spikes/drive-playback/run.mjs --token "$DRIVE_TOKEN" [--file-id <id>] [--seek 0.8]
```

Byte accounting comes from CDP (`Network.dataReceived`), and the proof that DNR
worked is `Network.requestWillBeSentExtraInfo` — the headers Chromium actually
sent, not what the page asked for.

## Why not your main Chrome?

Both verified on 2026-09-03, and both are why these scripts use Playwright's
bundled Chromium plus a pasted token rather than driving your real browser:

- **Chrome 152 ignores `--load-extension`**, including with
  `--disable-features=DisableLoadExtensionCommandLineSwitch`. `chrome://extensions`
  lists nothing.
- **Playwright's `connectOverCDP` cannot see extension service workers** in an
  already-running browser — `context.serviceWorkers()` comes back empty — so
  attaching to your Chrome and calling `getAuthToken` in the extension's worker
  is not available either.

`chrome.identity.getAuthToken` also needs Chrome's Google sign-in, which
Chromium does not have. If the spike ever needs to run unattended, the route is
the extension's existing `WebAuthFlowAuthProvider` (ADR-0002), which works on
plain Chromium.

## Scope

These scripts prove the *transport*. They do not prove container seekability on
a large real recording — plan section 20 wants a large MediaRecorder-produced
WebM, so prefer a multi-hundred-MB file for `run.mjs`. A far seek that still
drags a long prefix means container indexing, not the player architecture.
