// The sign-in page. Plain HTML and a form, with no script, so it works under the page's strict content policy.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function loginPage(o: { error?: string | null; firstStart: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Crossbill</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f4f2; --card: #fff; --text: #1b1a19; --muted: #6b6560; --accent: #a3242a; --line: #ddd6d0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121110; --card: #1d1b1a; --text: #f1ece8; --muted: #a39b94; --accent: #e0545a; --line: #34302d; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 16px; }
  main { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; font: inherit; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { margin-top: 16px; width: 100%; font: inherit; font-weight: 600; padding: 12px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
  .error { color: var(--accent); font-size: 14px; margin: 12px 0 0; }
</style>
</head>
<body>
<main>
  <h1>Crossbill</h1>
  <p>Sign in to Crossbill on this server.${o.firstStart ? ' The server made its first password when it started: it’s in the server’s log and its data folder (on StartOS, in Crossbill’s actions).' : ''}</p>
  <form method="post" action="/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    ${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ''}
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
`;
}

export function notBuiltPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Crossbill</title></head><body>
<p>Crossbill’s screens aren’t built on this server. Run <code>npm run build:server</code>, or set CROSSBILL_STATIC_DIR.</p>
</body></html>`;
}
