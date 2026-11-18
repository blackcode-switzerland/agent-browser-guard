# agent-browser-guard

A browser for a person's AI agents, with the person's own signed-in profile, behind rules the agent cannot switch off.

It wraps Microsoft's [Playwright MCP server](https://github.com/microsoft/playwright-mcp) and sits in front of it as a filter.

## Rules

- Only Playwright's bundled Chromium, never the person's Chrome or Edge.
- One fixed profile folder per person. No option chooses another browser, profile or debugging port.
- On Windows the native sign-in dialog is off (`--disable-features=WebAuthenticationUseNativeWinApi`), and an empty virtual authenticator is added before the first page, so an agent cannot make a passkey or security-key prompt appear on the person's screen.
- Agents never type passwords or one-time codes:
  1. a call that types into a field named as a secret is refused before it reaches the browser;
  2. a script in every page makes password and one-time-code fields read-only in agent sessions;
  3. the tools that run arbitrary script (which could undo 2) are removed.
- The person signs in themselves. The agent calls `browser_human_sign_in` with the page address: the agent's browser is closed, a visible window opens on the same profile with no agent connected, and the agent continues when the person closes it.

## Install for yourself

Windows: `powershell -ExecutionPolicy Bypass -File install\install.ps1`  
macOS / Linux: `sh install/install.sh`

No administrator rights. It needs Node.js 18 or newer, copies the tool into your own application-data folder, fetches the Playwright MCP server and Playwright's own Chromium, registers the tool server `agent-browser` in Claude Code and Codex when they are installed, and ends with one line that begins with `OK` or `NOT OK`. `-CheckOnly` / `--check-only` repeats the check; `-NoRegister` / `--no-register` skips the registration. Run it yourself: it is your tool and your profile.

## Use from a checkout

```
npm ci
npx playwright install chromium
node agent-browser-guard.mjs check
```

Register `node /path/to/agent-browser-guard.mjs mcp` as a stdio MCP server in your agent tool.

| Command | What it does |
|---|---|
| `mcp` | the tool server (stdin/stdout) |
| `sign-in <https url>` | opens a window for the person to sign in |
| `check` | one line: is everything in place |
| `install-browser` | downloads Playwright's own Chromium (about 150 MB, once) |
| `version` | the version |

Profile folder: `%LOCALAPPDATA%\AgentBrowser\profile` (Windows), `~/Library/Application Support/AgentBrowser/profile` (macOS), `~/.local/share/agent-browser/profile` (Linux). `AGENT_BROWSER_PROFILE` overrides it (used by the tests for a throwaway profile). Agent sessions run without a window; `AGENT_BROWSER_HEADED=1` shows it.

## Tests

`npm test` runs the rule and filter tests without a browser. `npm run test:browser` drives the real launcher against a local page and judges from what the test server receives; it runs on Linux CI.

## Limits

- The check on field names is a word list; the read-only guard in the page is the real barrier.
- Not yet confirmed: whether every sign-in provider keeps a session in a browser without a window.
- A site can always ask for a secret in a way no guard recognises (a plain text field). Do not give agents secrets to type.

MIT licence.