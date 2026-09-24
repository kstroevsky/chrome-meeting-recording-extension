const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export function viewerShell(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Shared recording</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0c0d10; color: #f4f5f7; }
    button, input { font: inherit; }
    button { color: inherit; }
    .shell { width: min(1220px, calc(100% - 32px)); margin: 0 auto; padding: 30px 0 48px; }
    .top { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
    .eyebrow { margin: 0 0 7px; color: #9da3ae; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 34px); letter-spacing: -.025em; }
    .recordings { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .recordings button, .topic, .note, .transcript-line { border: 1px solid #2e3239; background: #17191e; border-radius: 10px; cursor: pointer; }
    .recordings button { padding: 8px 12px; }
    .recordings button[aria-current="true"] { background: #f4f5f7; color: #101216; border-color: #f4f5f7; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); gap: 18px; align-items: start; }
    .card { border: 1px solid #262a31; background: #121419; border-radius: 16px; overflow: hidden; box-shadow: 0 18px 60px rgba(0,0,0,.28); }
    .stage { position: relative; min-height: 280px; display: grid; place-items: center; background: #050607; }
    .stage > video.master { width: 100%; max-height: 72vh; display: block; background: #050607; }
    .stage > audio.master { width: min(680px, calc(100% - 40px)); }
    .aux-video { position: absolute; right: 18px; bottom: 18px; width: min(28%, 270px); aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid rgba(255,255,255,.2); border-radius: 12px; background: #090a0c; box-shadow: 0 10px 35px rgba(0,0,0,.45); }
    .meta { display: grid; gap: 14px; padding: 16px 18px 18px; }
    .meta-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px 18px; align-items: center; }
    .time { color: #aeb3bd; font-variant-numeric: tabular-nums; font-size: 13px; }
    .mixers { display: flex; flex-wrap: wrap; gap: 12px 18px; }
    .mixer { display: grid; grid-template-columns: auto minmax(90px, 150px) 42px; gap: 8px; align-items: center; color: #d9dce2; font-size: 13px; }
    .mixer input { width: 100%; }
    .mixer output { color: #9da3ae; text-align: right; font-variant-numeric: tabular-nums; }
    .panel { padding: 18px; }
    .panel + .panel { border-top: 1px solid #262a31; }
    .panel h2 { margin: 0 0 12px; font-size: 13px; color: #aeb3bd; letter-spacing: .09em; text-transform: uppercase; }
    .topics, .notes { display: flex; flex-wrap: wrap; gap: 8px; }
    .topic, .note { padding: 8px 10px; text-align: left; }
    .topic:hover, .note:hover, .transcript-line:hover { border-color: #555c68; }
    .topic small, .note small { display: block; color: #9299a4; margin-top: 3px; }
    .transcript { display: grid; gap: 6px; max-height: 56vh; overflow: auto; padding-right: 4px; }
    .transcript-line { width: 100%; padding: 10px 11px; text-align: left; line-height: 1.4; }
    .transcript-line strong { display: block; margin-bottom: 3px; font-size: 12px; color: #9da3ae; font-weight: 600; }
    .transcript-line.active { border-color: #8f98a7; background: #23262d; }
    .empty { color: #8f96a1; font-size: 14px; }
    .unavailable { min-height: 70vh; display: grid; place-items: center; text-align: center; padding: 32px; }
    .unavailable h1 { margin-bottom: 10px; }
    .unavailable p { color: #9da3ae; max-width: 480px; line-height: 1.55; }
    [hidden] { display: none !important; }
    @media (max-width: 860px) {
      .shell { width: min(100% - 20px, 760px); padding-top: 18px; }
      .top { display: grid; }
      .recordings { justify-content: flex-start; }
      .layout { grid-template-columns: 1fr; }
      .stage { min-height: 220px; }
      .transcript { max-height: 440px; }
      .aux-video { width: 34%; right: 10px; bottom: 10px; }
    }
  </style>
</head>
<body>
  <main id="app" class="shell">
    <header class="top">
      <div>
        <p class="eyebrow">Shared recording</p>
        <h1 id="recording-title">Loading…</h1>
      </div>
      <nav id="recordings" class="recordings" aria-label="Recordings in this share"></nav>
    </header>
    <div id="viewer" class="layout" hidden>
      <section class="card">
        <div id="stage" class="stage" aria-label="Recording player"></div>
        <div class="meta">
          <div class="meta-row">
            <span id="clock" class="time">0:00 / 0:00</span>
            <div id="mixers" class="mixers" aria-label="Track volume"></div>
          </div>
        </div>
      </section>
      <aside class="card">
        <section id="topics-panel" class="panel" hidden>
          <h2>Topics</h2>
          <div id="topics" class="topics"></div>
        </section>
        <section id="notes-panel" class="panel" hidden>
          <h2>Notes</h2>
          <div id="notes" class="notes"></div>
        </section>
        <section id="transcript-panel" class="panel" hidden>
          <h2>Transcript</h2>
          <div id="transcript" class="transcript"></div>
        </section>
      </aside>
    </div>
    <section id="unavailable" class="unavailable" hidden>
      <div>
        <h1>This share is no longer available</h1>
        <p>The owner may have revoked it, or this viewing session may have expired.</p>
      </div>
    </section>
  </main>
  <script type="module" src="/viewer/app.js"></script>
</body>
</html>`, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; media-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
