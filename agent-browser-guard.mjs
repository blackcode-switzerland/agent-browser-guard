#!/usr/bin/env node
// agent-browser-guard: a browser for a person's agents, with a signed-in profile of the person's own.
//
//   agent-browser-guard mcp                 the tool server for Claude Code / Codex (stdin/stdout)
//   agent-browser-guard sign-in <https url> opens a window for the PERSON to sign in; agents have no access to it
//   agent-browser-guard check               one line: is everything in place
//   agent-browser-guard install-browser     downloads Playwright's own Chromium (about 150 MB, once)
//   agent-browser-guard version
//
// It wraps Microsoft's Playwright MCP server and adds rules that an agent cannot switch off; see lib/rules.mjs.
// It takes no options that choose another browser, another profile or a debugging port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profileDir, launchArgs, upstreamConfig, signInUrlProblem } from './lib/rules.mjs';
import { runProxy, spawnUpstream } from './lib/proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const guardScript = path.join(here, 'guard', 'password-guard.js');
const authenticatorPage = path.join(here, 'guard', 'authenticator.ts');
const headless = process.env.AGENT_BROWSER_HEADED !== '1';

function upstreamCli() { return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'); }
// The same Playwright (and so the same bundled Chromium) that the MCP server itself uses.
function playwright() { return createRequire(require.resolve('@playwright/mcp/package.json'))('playwright'); }

async function bundledChromium() {
  const { chromium } = playwright();
  const file = chromium.executablePath();
  return fs.existsSync(file) ? file : null;
}

let chromiumSeen = false;
/** Null when the bundled Chromium is on disk; otherwise what is missing and how a person fixes it. */
function browserProblem() {
  if (chromiumSeen) return null;
  try { const { chromium } = playwright(); chromiumSeen = fs.existsSync(chromium.executablePath()); } catch { chromiumSeen = false; }
  return chromiumSeen ? null
    : `The browser for agents is not downloaded on this computer yet (about 150 MB, once). An agent cannot do this; a person runs: "${process.execPath}" "${fileURLToPath(import.meta.url)}" install-browser`;
}

function installBrowser() {
  const cli = path.join(path.dirname(createRequire(require.resolve('@playwright/mcp/package.json')).resolve('playwright/package.json')), 'cli.js');
  const done = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  if (done.status === 0 && !browserProblem()) { console.log('OK: the browser is installed.'); return 0; }
  console.log('NOT OK: the browser download did not finish. Check the network connection and run this command again.');
  return 1;
}

async function addAuthenticator(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('WebAuthn.enable');
  await session.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: false, automaticPresenceSimulation: false } });
}

/** The window in which the person signs in. No agent tool is connected to it and the password guard is not loaded. */
async function humanSignIn(url, minutes = 15) {
  const { chromium } = playwright();
  const context = await chromium.launchPersistentContext(profileDir(), { channel: 'chromium', headless: false, args: launchArgs() });
  try {
    context.on('page', page => addAuthenticator(page).catch(() => {}));
    const page = context.pages()[0] || await context.newPage();
    await addAuthenticator(page).catch(() => {});
    await page.goto(url);
    const closed = new Promise(done => context.once('close', () => done('closed')));
    const outcome = await Promise.race([closed, new Promise(done => setTimeout(() => done('timeout'), minutes * 60000).unref())]);
    return outcome === 'closed'
      ? 'The person has closed the sign-in window. Open the page again and check whether you are signed in.'
      : `The sign-in window was still open after ${minutes} minutes and has been closed. Ask the person before trying again.`;
  } finally { await context.close().catch(() => {}); }
}

async function check() {
  const problems = [];
  let upstreamVersion = '?';
  try { upstreamVersion = require('@playwright/mcp/package.json').version; } catch { problems.push('the Playwright MCP server is not installed (run npm ci in this folder)'); }
  let chromium = null;
  try { chromium = await bundledChromium(); } catch { problems.push('Playwright is not installed (run npm ci in this folder)'); }
  if (!chromium && problems.length === 0) problems.push('the bundled Chromium is not downloaded (run: npx playwright install chromium)');
  for (const file of [guardScript, authenticatorPage]) if (!fs.existsSync(file)) problems.push(`missing: ${file}`);
  const profile = profileDir();
  if (problems.length) { console.log(`NOT OK: ${problems.join('; ')}`); return 1; }
  console.log(`OK: agent-browser-guard ${pkg.version}, Playwright MCP ${upstreamVersion}, bundled Chromium present, profile ${profile}${fs.existsSync(profile) ? '' : ' (created at first use)'}`);
  return 0;
}

async function mcp() {
  const profile = profileDir();
  fs.mkdirSync(profile, { recursive: true });
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-guard-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(upstreamConfig({ profile, guardScript, authenticatorPage, headless }), null, 2));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PLAYWRIGHT_MCP_')) delete env[key];   // no setting from outside overrides the rules
  await runProxy({
    startUpstream: () => spawnUpstream(process.execPath, upstreamCli(), configPath, env),
    humanSignIn,
    browserProblem,
    input: process.stdin, output: process.stdout,
    log: line => process.stderr.write(`[agent-browser-guard] ${line}\n`),
  });
  try { fs.rmSync(path.dirname(configPath), { recursive: true, force: true }); } catch {}
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'mcp' && rest.length === 0) await mcp();
else if (command === 'check' && rest.length === 0) process.exitCode = await check();
else if (command === 'install-browser' && rest.length === 0) process.exitCode = installBrowser();
else if (command === 'version' && rest.length === 0) console.log(`agent-browser-guard ${pkg.version}`);
else if (command === 'sign-in' && rest.length === 1) {
  const problem = signInUrlProblem(rest[0]);
  if (problem) { console.error(problem); process.exitCode = 2; }
  else console.log(await humanSignIn(rest[0]));
} else {
  console.error('usage: agent-browser-guard mcp | sign-in <https url> | check | install-browser | version   (no other options: the browser, the profile and the rules are fixed)');
  process.exitCode = 2;
}
