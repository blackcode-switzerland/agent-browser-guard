// Runs on Linux CI only, never on a person's machine, with a throwaway profile and a page served from 127.0.0.1.
// It drives the real launcher (agent-browser-guard mcp -> Microsoft's Playwright MCP -> bundled Chromium) the way
// an agent would, and checks from OUTSIDE the browser (what the test server received) that
//   - an ordinary field can be typed into,
//   - a password field takes nothing, even when the agent describes it innocently,
//   - the page sees a platform authenticator (the virtual one), so a passkey request cannot fall through to the system.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-browser-guard.mjs');
const PAGE = `<!doctype html><title>Sign in to Fixture</title>
<form method="post" action="/submit">
  <label>User name <input name="user" type="text"></label>
  <label>Second field <input name="secret" type="password"></label>
  <button type="submit">Continue</button>
</form>
<p id="authenticator">checking</p>
<script>
  (window.PublicKeyCredential ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : Promise.resolve('no-webauthn'))
    .then(v => document.getElementById('authenticator').textContent = 'platform authenticator: ' + v);
</script>`;

function fixtureServer() {
  const posted = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = ''; req.on('data', c => body += c); req.on('end', () => { posted.push(Object.fromEntries(new URLSearchParams(body))); res.end('<title>Received</title><p>received</p>'); });
    } else { res.setHeader('content-type', 'text/html'); res.end(PAGE); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, posted, url: `http://127.0.0.1:${server.address().port}/` })));
}

function agent(profile) {
  const child = spawn(process.execPath, [launcher, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, AGENT_BROWSER_PROFILE: profile } });
  const waiting = new Map(); let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } });
  const ask = (method, params) => new Promise((resolve, reject) => {
    const mine = ++id; waiting.set(mine, resolve);
    setTimeout(() => reject(new Error(`no answer to ${method} ${JSON.stringify(params).slice(0, 80)}`)), 90000).unref();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
  });
  const call = async (name, args) => { const a = await ask('tools/call', { name, arguments: args }); return { text: (a.result.content || []).map(c => c.text || '').join('\n'), isError: !!a.result.isError }; };
  const end = () => new Promise(done => { child.once('exit', done); child.stdin.end(); setTimeout(() => child.kill(), 15000).unref(); });
  return { ask, call, end };
}
const refOf = (snapshot, label) => { const m = new RegExp(`${label}[^\\n]*\\[ref=([^\\]]+)\\]`).exec(snapshot); assert.ok(m, `no ref for "${label}" in:\n${snapshot}`); return m[1]; };

test('rules hold in the real bundled Chromium', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-test-profile-'));
  const { server, posted, url } = await fixtureServer();
  const a = agent(profile);
  try {
    await a.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci', version: '1' } });
    const names = (await a.ask('tools/list', {})).result.tools.map(t => t.name);
    assert.ok(names.includes('browser_navigate') && names.includes('browser_human_sign_in'), names.join(','));
    assert.ok(!names.some(n => /evaluate|run_code/.test(n)), names.join(','));

    await a.call('browser_navigate', { url });
    const snapshot = (await a.call('browser_snapshot', {})).text;
    assert.match(snapshot, /platform authenticator: true/, 'the virtual authenticator was added before the first page');

    const user = await a.call('browser_type', { element: 'User name', ref: refOf(snapshot, 'User name'), text: 'alex' });
    assert.equal(user.isError, false, user.text);

    // Named honestly, the call is refused before it reaches the browser.
    const named = await a.call('browser_type', { element: 'Password', ref: refOf(snapshot, 'Second field'), text: 'hunter2' });
    assert.equal(named.isError, true);
    // Named innocently, it reaches the browser, and the guard inside the page must hold.
    const sneaky = await a.call('browser_type', { element: 'Second field', ref: refOf(snapshot, 'Second field'), text: 'hunter2' });
    const again = (await a.call('browser_snapshot', {})).text;
    assert.doesNotMatch(again, /hunter2/);

    await a.call('browser_click', { element: 'Continue', ref: refOf(again, 'Continue') });
    for (let i = 0; i < 50 && posted.length === 0; i++) await new Promise(r => setTimeout(r, 200));
    assert.equal(posted.length, 1, 'the form was submitted');
    assert.equal(posted[0].user, 'alex');
    assert.equal(posted[0].secret, '', `the password field stayed empty (the typing call said: ${sneaky.text.slice(0, 200)})`);
  } finally {
    await a.end(); server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
