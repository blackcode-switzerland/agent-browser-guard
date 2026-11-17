// Stands in for Microsoft's Playwright MCP server in the offline tests: no browser is started.
import readline from 'node:readline';
const tools = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_evaluate', 'browser_run_code_unsafe', 'browser_install', 'browser_file_upload']
  .map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
const say = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') say({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake', version: '0', pid: process.pid }, capabilities: { tools: {} } } });
  else if (message.method === 'tools/list') say({ jsonrpc: '2.0', id: message.id, result: { tools } });
  else if (message.method === 'tools/call') say({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `upstream ran ${message.params.name} in process ${process.pid}` }] } });
});
