// A filter between the agent and Microsoft's Playwright MCP server (both speak newline-delimited
// JSON-RPC over stdin/stdout). It removes the tools an agent must not have, refuses calls that would
// type a secret, and adds one tool of its own: the human sign-in.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { callRefusal, filterToolList, SIGN_IN_TOOL, signInUrlProblem } from './rules.mjs';

const text = (message, isError = false) => ({ content: [{ type: 'text', text: message }], isError });

/**
 * @param {object} o
 * @param {() => import('node:child_process').ChildProcess} o.startUpstream starts the real server
 * @param {(url: string) => Promise<string>} o.humanSignIn opens the window for the person; resolves with a sentence for the agent
 * @param {NodeJS.ReadableStream} o.input  @param {NodeJS.WritableStream} o.output
 * @param {(line: string) => void} [o.log]
 * @param {() => (string|null)} [o.browserProblem] a sentence when the browser itself is not installed, else null
 */
export function runProxy({ startUpstream, humanSignIn, input, output, log = () => {}, browserProblem = () => null }) {
  let upstream = null;
  let initialize = null;              // the agent's initialize request, replayed when the upstream is restarted
  let restarting = Promise.resolve();
  const listRequests = new Set();     // ids of tools/list requests whose answer must be filtered
  const swallow = new Set();          // ids of our own requests to the upstream
  let own = 0;

  const toAgent = message => output.write(JSON.stringify(message) + '\n');
  const toUpstream = message => { if (upstream && upstream.stdin.writable) upstream.stdin.write(JSON.stringify(message) + '\n'); };

  function connect() {
    upstream = startUpstream();
    const child = upstream;
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && swallow.delete(message.id)) return;
      if (message.id !== undefined && listRequests.delete(message.id) && message.result) message = { ...message, result: filterToolList(message.result) };
      toAgent(message);
    });
    child.on('exit', code => { log(`upstream ended (${code})`); if (upstream === child) upstream = null; });
  }

  async function restartUpstream() {
    const old = upstream; upstream = null;
    if (old) { await new Promise(done => { old.once('exit', done); old.stdin.end(); setTimeout(() => { try { old.kill(); } catch {} done(); }, 5000); }); }
    connect();
    if (initialize) {
      const id = `agent-browser-guard-${++own}`; swallow.add(id);
      toUpstream({ ...initialize, id });
      toUpstream({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
  }

  async function handle(message) {
    if (message.method === 'initialize') initialize = message;
    if (message.method === 'tools/list' && message.id !== undefined) listRequests.add(message.id);
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params || {};
      // Without the browser nothing can work, and the upstream error would point the agent at an
      // install tool it does not have. Say what is missing and who can fix it.
      const missing = browserProblem();
      if (missing) return toAgent({ jsonrpc: '2.0', id: message.id, result: text(missing, true) });
      if (name === SIGN_IN_TOOL) {
        const problem = signInUrlProblem(args && args.url);
        if (problem) return toAgent({ jsonrpc: '2.0', id: message.id, result: text(problem, true) });
        // The agent's browser is closed first: one profile, one browser, and no agent hand in the sign-in.
        restarting = restarting.then(async () => {
          const old = upstream; upstream = null;
          if (old) await new Promise(done => { old.once('exit', done); old.stdin.end(); setTimeout(() => { try { old.kill(); } catch {} done(); }, 5000); });
          let outcome;
          try { outcome = text(await humanSignIn(args.url)); } catch (error) { outcome = text(`The sign-in window could not be opened: ${error.message}`, true); }
          await restartUpstream();
          toAgent({ jsonrpc: '2.0', id: message.id, result: outcome });
        });
        return;
      }
      const refusal = callRefusal(name, args);
      if (refusal) { log(`refused ${name}`); return toAgent({ jsonrpc: '2.0', id: message.id, result: text(refusal, true) }); }
    }
    await restarting;
    if (!upstream) connect();
    toUpstream(message);
  }

  connect();
  const lines = readline.createInterface({ input });
  let queue = Promise.resolve();
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    queue = queue.then(() => handle(message)).catch(error => log(`error: ${error.message}`));
  });
  return new Promise(done => lines.on('close', () => queue.then(() => restarting).then(() => { if (upstream) { upstream.stdin.end(); setTimeout(() => { try { upstream && upstream.kill(); } catch {} }, 3000).unref(); } done(); })));
}

export function spawnUpstream(nodePath, cliPath, configPath, env) {
  return spawn(nodePath, [cliPath, '--config', configPath], { stdio: ['pipe', 'pipe', 'inherit'], env, windowsHide: true });
}
