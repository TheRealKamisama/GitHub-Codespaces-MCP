import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/mcp.js';
import { AppError } from '../dist/errors.js';

const build = JSON.parse(await readFile('dist/build.json', 'utf8'));
test('official SDK real stdio initialize/list/call/close/reconnect; no cloud calls on startup', async () => {
  for (let i = 0; i < 2; i++) {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve', '--stdio'], stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', data => { stderr += data.toString(); });
    const client = new Client({ name: 'm0-test', version: '1' });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().version, build.version);
      assert.deepEqual(Object.keys(client.getServerCapabilities()), ['tools']);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(t => t.name), ['environment_check', 'codespace_list', 'project_bind', 'codespace_prepare', 'runner_probe']);
      for (const tool of tools) { assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.outputSchema.type, 'object'); }
      const result = await client.callTool({ name: 'codespace_prepare', arguments: { projectId: 'x', requestId: 'x', policy: 'create_if_missing', locale: 'zh-CN' } });
      assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
      assert.equal(result.structuredContent.error.message, '工具参数无效。');
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      await assert.rejects(client.callTool({ name: 'missing_tool', arguments: {} }));
    } finally { await client.close(); }
    assert.equal(stderr, '');
  }
});
test('SDK contract validates successful structured output and localized auth errors', async () => {
  const identity = { account: 'fixture', host: 'github.com', authSource: 'fixture-source', ghVersion: 'fixture' };
  const app = { gh: { identity: async () => identity } };
  const server = createServer(app, build);
  const client = new Client({ name: 'contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    await client.listTools();
    const success = await client.callTool({ name: 'environment_check', arguments: {} });
    assert.deepEqual(success.structuredContent.data, identity); assert.equal(success.isError, false);
    app.gh.identity = async () => { throw new AppError('AUTH_REQUIRED'); };
    for (const locale of ['en', 'zh-CN']) {
      const failure = await client.callTool({ name: 'environment_check', arguments: { locale } });
      assert.equal(failure.isError, true); assert.equal(failure.structuredContent.error.code, 'AUTH_REQUIRED');
      assert.deepEqual(JSON.parse(failure.content[0].text), failure.structuredContent);
    }
  } finally { await client.close(); await server.close(); }
});
