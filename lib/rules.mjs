// The rules of the per-person browser, as pure functions (tested without a browser).
//
// 1. Only Playwright's bundled Chromium, never the person's Chrome or Edge.
// 2. One fixed profile folder per person.
// 3. On Windows the native sign-in dialog is switched off (--disable-features=WebAuthenticationUseNativeWinApi)
//    and a virtual authenticator is added before the first page, so no Windows Hello / security-key
//    prompt can appear on the person's screen because of an agent.
// 4. Agents never type passwords or one-time codes. The human signs in, in a window the agent has no hand in.
import os from 'node:os';
import path from 'node:path';

export const WINDOWS_FLAG = '--disable-features=WebAuthenticationUseNativeWinApi';

export function profileDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AGENT_BROWSER_PROFILE) return path.resolve(env.AGENT_BROWSER_PROFILE);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'AgentBrowser', 'profile');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'AgentBrowser', 'profile');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'agent-browser', 'profile');
}

export function launchArgs(platform = process.platform) {
  return platform === 'win32' ? [WINDOWS_FLAG] : [];
}

/** The configuration handed to Microsoft's Playwright MCP server. Nothing here can be overridden by an agent. */
export function upstreamConfig({ profile, guardScript, authenticatorPage, headless, platform = process.platform }) {
  return {
    browser: {
      browserName: 'chromium',
      userDataDir: profile,
      launchOptions: { channel: 'chromium', headless: !!headless, args: launchArgs(platform) },
      initScript: [guardScript],
      initPage: [authenticatorPage],
    },
    capabilities: ['core'],
    allowUnrestrictedFileAccess: false,
  };
}

// Tools of the upstream server that an agent does not get: they run arbitrary script in the page or
// in the server (which would undo the password guard), or change the browser installation.
const BLOCKED_TOOLS = [/evaluate/i, /run_code/i, /^browser_install$/i, /devtools/i, /^browser_file_upload$/i];
export function toolBlocked(name) { return BLOCKED_TOOLS.some(rule => rule.test(name || '')); }

// A second line behind the guard inside the page: a call that names a secret field is refused before it is sent.
const SECRET_WORDS = /pass\s*(word|code|phrase)|passwort|kennwort|mot\s+de\s+passe|contrase|\bpin\b|\botp\b|one[- ]?time|2fa|verification\s+code|code\s+de\s+(v[ée]rification|s[ée]curit[ée])|security\s+code|\bcvv\b|\bcvc\b/i;
const TYPING_TOOLS = /^browser_(type|fill_form|press_key|press_sequentially|select_option|drop)$/i;

export const SIGN_IN_TOOL = 'browser_human_sign_in';
export const SIGN_IN_HINT = `Passwords and one-time codes are typed by the human, never by an agent. Call ${SIGN_IN_TOOL} with the page address: a window opens for the person to sign in, and you continue when they have closed it.`;

/** Null when the call may go on; otherwise the text of the refusal. */
export function callRefusal(name, args) {
  if (toolBlocked(name)) return `The tool ${name} is not available in this browser.`;
  if (!TYPING_TOOLS.test(name || '')) return null;
  const described = [];
  const collect = value => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach(collect);
    if (typeof value === 'object') { for (const key of ['element', 'name', 'target', 'type', 'label', 'fields']) collect(value[key]); return; }
    described.push(String(value));
  };
  collect(args);
  return described.some(text => SECRET_WORDS.test(text)) ? `Not typed. ${SIGN_IN_HINT}` : null;
}

export function signInToolDefinition() {
  return {
    name: SIGN_IN_TOOL,
    description: 'Ask the person to sign in themselves. Opens the page in a browser window on their screen, with the same profile; you have no access while it is open. Returns when they close the window (or after 15 minutes). Use it whenever a page asks for a password, a one-time code or a passkey.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The https address of the sign-in page.' } }, required: ['url'] },
  };
}

/** The tools/list answer the agent sees: blocked tools removed, the human sign-in tool added. */
export function filterToolList(result) {
  const tools = ((result && result.tools) || []).filter(tool => !toolBlocked(tool.name));
  return { ...result, tools: [...tools, signInToolDefinition()] };
}

export function signInUrlProblem(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return 'Give the full https address of the sign-in page.'; }
  if (parsed.protocol !== 'https:') return 'Only https addresses can be opened for a sign-in.';
  return null;
}
