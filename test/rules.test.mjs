import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { profileDir, launchArgs, upstreamConfig, toolBlocked, callRefusal, filterToolList, signInUrlProblem, WINDOWS_FLAG, SIGN_IN_TOOL } from '../lib/rules.mjs';

test('one fixed profile folder per person, per system', () => {
  assert.equal(profileDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x'), path.join('C:\\Users\\x\\AppData\\Local', 'AgentBrowser', 'profile'));
  assert.equal(profileDir({}, 'darwin', '/Users/x'), path.join('/Users/x', 'Library', 'Application Support', 'AgentBrowser', 'profile'));
  assert.equal(profileDir({}, 'linux', '/home/x'), path.join('/home/x', '.local', 'share', 'agent-browser', 'profile'));
  assert.equal(profileDir({ AGENT_BROWSER_PROFILE: path.resolve('throwaway') }, 'linux', '/home/x'), path.resolve('throwaway'));
});

test('the Windows sign-in flag is set on Windows only', () => {
  assert.deepEqual(launchArgs('win32'), [WINDOWS_FLAG]);
  assert.deepEqual(launchArgs('darwin'), []);
});

test('the upstream configuration names the bundled Chromium, the profile, the guard and the authenticator', () => {
  const config = upstreamConfig({ profile: '/p', guardScript: '/g.js', authenticatorPage: '/a.ts', headless: true, platform: 'win32' });
  assert.equal(config.browser.browserName, 'chromium');
  assert.equal(config.browser.launchOptions.channel, 'chromium');           // never the person's Chrome or Edge
  assert.equal(config.browser.launchOptions.executablePath, undefined);
  assert.equal(config.browser.cdpEndpoint, undefined);                      // no debugging port
  assert.equal(config.browser.userDataDir, '/p');
  assert.deepEqual(config.browser.launchOptions.args, [WINDOWS_FLAG]);
  assert.deepEqual(config.browser.initScript, ['/g.js']);
  assert.deepEqual(config.browser.initPage, ['/a.ts']);
  assert.deepEqual(config.capabilities, ['core']);
  assert.equal(config.allowUnrestrictedFileAccess, false);
});

test('tools that run script or change the installation are blocked', () => {
  for (const name of ['browser_evaluate', 'browser_run_code_unsafe', 'browser_run_code', 'browser_install', 'browser_file_upload'])
    assert.equal(toolBlocked(name), true, name);
  for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot', 'browser_fill_form'])
    assert.equal(toolBlocked(name), false, name);
});

test('typing into a field described as a secret is refused, in several languages', () => {
  const refused = [
    ['browser_type', { element: 'Password textbox', ref: 'e12', text: 'x' }],
    ['browser_type', { element: 'Mot de passe', ref: 'e3', text: 'x' }],
    ['browser_type', { element: 'Passwort', ref: 'e3', text: 'x' }],
    ['browser_type', { element: 'Enter the 6-digit verification code', ref: 'e3', text: '123456' }],
    ['browser_type', { element: 'One-time code', ref: 'e3', text: '123456' }],
    ['browser_fill_form', { fields: [{ name: 'E-mail', type: 'textbox', ref: 'e1', value: 'a@b.c' }, { name: 'Password', type: 'textbox', ref: 'e2', value: 'x' }] }],
    ['browser_evaluate', { function: '() => 1' }],
  ];
  for (const [name, args] of refused) assert.ok(callRefusal(name, args), `${name} ${JSON.stringify(args)}`);
  const allowed = [
    ['browser_type', { element: 'Search', ref: 'e1', text: 'password reset instructions' }],      // the TEXT may contain the word
    ['browser_type', { element: 'E-mail address', ref: 'e1', text: 'a@b.c' }],
    ['browser_fill_form', { fields: [{ name: 'First name', type: 'textbox', ref: 'e1', value: 'Alex' }] }],
    ['browser_click', { element: 'Forgot password?', ref: 'e9' }],                                 // clicking is not typing
    ['browser_navigate', { url: 'https://example.com/password' }],
  ];
  for (const [name, args] of allowed) assert.equal(callRefusal(name, args), null, `${name} ${JSON.stringify(args)}`);
});

test('the tool list the agent sees: blocked tools gone, the human sign-in added', () => {
  const seen = filterToolList({ tools: [{ name: 'browser_navigate' }, { name: 'browser_evaluate' }, { name: 'browser_run_code_unsafe' }, { name: 'browser_type' }] }).tools.map(t => t.name);
  assert.deepEqual(seen, ['browser_navigate', 'browser_type', SIGN_IN_TOOL]);
});

test('a sign-in window opens https addresses only', () => {
  assert.equal(signInUrlProblem('https://accounts.google.com/'), null);
  for (const bad of ['http://example.com', 'file:///C:/x.html', 'javascript:alert(1)', 'accounts.google.com', '', undefined]) assert.ok(signInUrlProblem(bad), String(bad));
});
