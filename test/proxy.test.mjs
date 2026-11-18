import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runProxy } from '../lib/proxy.mjs';
import { SIGN_IN_TOOL } from '../lib/rules.mjs';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-upstream.mjs');

function session() {
  const input = new PassThrough(), output = new PassThrough();
  const started = [], signIns = [];
  const done = runProxy({
    startUpstream: () => { const child = spawn(process.execPath, [fake], { stdio: ['pipe', 'pipe', 'inherit'] }); started.push(child); return child; },
    humanSignIn: async url => { signIns.push({ url, upstreamAlive: started.some(c => c.exitCode === null && !c.killed && c.stdin.writable) }); return 'The person has closed the sign-in window.'; },
    input, output,
  });
  const waiting = new Map();
  readline.createInterface({ input: output }).on('line', line => { const m = JSON.parse(line); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } });
  let id = 0;
  const ask = (method, params) => new Promise((resolve, reject) => {
    const mine = ++id; waiting.set(mine, resolve);
    setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000).unref();
    input.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
  });
  const end = async () => { input.end(); await done; };
  return { ask, end, started, signIns };
}
const said = answer => answer.result.content[0].text;

test('the agent sees the filtered tool list and normal calls pass through', async () => {
  const s = session();
  await s.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const names = (await s.ask('tools/list', {})).result.tools.map(t => t.name);
  assert.ok(names.includes('browser_navigate') && names.includes(SIGN_IN_TOOL));
  for (const gone of ['browser_evaluate', 'browser_run_code_unsafe', 'browser_install', 'browser_file_upload']) assert.ok(!names.includes(gone), gone);
  assert.match(said(await s.ask('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com' } })), /upstream ran browser_navigate/);
  await s.end();
});

test('a blocked tool and a secret field never reach the upstream server', async () => {
  const s = session();
  await s.ask('initialize', {});
  const blocked = await s.ask('tools/call', { name: 'browser_evaluate', arguments: { function: '() => document.querySelector("input").value = "x"' } });
  assert.equal(blocked.result.isError, true); assert.doesNotMatch(said(blocked), /upstream ran/);
  const secret = await s.ask('tools/call', { name: 'browser_type', arguments: { element: 'Password', ref: 'e2', text: 'hunter2' } });
  assert.equal(secret.result.isError, true); assert.match(said(secret), new RegExp(SIGN_IN_TOOL)); assert.doesNotMatch(said(secret), /hunter2|upstream ran/);
  await s.end();
});

test('without the browser every call says what is missing and reaches nothing', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let missing = 'The browser for agents is not downloaded on this computer yet';
  let started = 0;
  const done = runProxy({
    startUpstream: () => { started++; return spawn(process.execPath, [fake], { stdio: ['pipe', 'pipe', 'inherit'] }); },
    humanSignIn: async () => 'x', input, output, browserProblem: () => missing,
  });
  const answers = new Map();
  readline.createInterface({ input: output }).on('line', line => { const m = JSON.parse(line); answers.get(m.id)?.(m); });
  const ask = (id, name) => new Promise(resolve => { answers.set(id, resolve); input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { url: 'https://example.com' } } }) + '\n'); });
  const refused = await ask(1, 'browser_navigate');
  assert.equal(refused.result.isError, true); assert.match(said(refused), /not downloaded/); assert.doesNotMatch(said(refused), /upstream ran/);
  const signIn = await ask(2, SIGN_IN_TOOL);
  assert.equal(signIn.result.isError, true); assert.match(said(signIn), /not downloaded/);
  missing = null;
  assert.match(said(await ask(3, 'browser_navigate')), /upstream ran browser_navigate/);
  input.end(); await done;
});

test('human sign-in: the agent browser is closed first, then a fresh one is started and works', async () => {
  const s = session();
  await s.ask('initialize', {});
  const before = said(await s.ask('tools/call', { name: 'browser_snapshot', arguments: {} }));
  const answer = await s.ask('tools/call', { name: SIGN_IN_TOOL, arguments: { url: 'https://accounts.example.com/login' } });
  assert.match(said(answer), /closed the sign-in window/);
  assert.deepEqual(s.signIns, [{ url: 'https://accounts.example.com/login', upstreamAlive: false }]);   // no agent browser while the person signs in
  const after = said(await s.ask('tools/call', { name: 'browser_snapshot', arguments: {} }));
  assert.match(after, /upstream ran browser_snapshot/);
  assert.notEqual(before, after);                                   // a different upstream process answered
  assert.equal(s.started.length, 2);
  const refused = await s.ask('tools/call', { name: SIGN_IN_TOOL, arguments: { url: 'http://insecure.example.com' } });
  assert.equal(refused.result.isError, true); assert.equal(s.signIns.length, 1);
  await s.end();
});
