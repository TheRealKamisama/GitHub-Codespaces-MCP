import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp.js';
import { Store } from './storage.js';
import { Github } from './github.js';
import { Application } from './application.js';
import { Runner, buildSchema } from './transport/runner.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== 'serve' || args[1] !== '--stdio') {
  process.stderr.write('Usage: node dist/cli.js serve --stdio\n'); process.exitCode = 2;
} else {
  const build = buildSchema.parse(JSON.parse(await readFile(new URL('./build.json', import.meta.url), 'utf8')));
  const state = process.env.CODESPACE_MCP_STATE_DIR ? resolve(process.env.CODESPACE_MCP_STATE_DIR) : join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'github-codespace-mcp');
  const gh = new Github();
  const app = new Application(new Store(state), gh, new Runner(gh, build));
  await createServer(app, build).connect(new StdioServerTransport());
}
