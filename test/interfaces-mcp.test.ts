import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/platform/mcp.js';
import type { InterfaceService } from '../src/platform/interfaces.js';

test('official MCP protocol exposes only read tools by default and validates tool inputs', async t => {
  const calls: unknown[] = [];
  // This test exercises only registered read callbacks; other service methods must not run.
  const service = { listSources: async () => [{ id: 'independent-fixture', fixture: true }], searchCases: async (input: unknown) => { calls.push(input); return { data: [] }; } } as unknown as InterfaceService;
  const server = createMcpServer(service, { env: {} });
  const client = new Client({ name: 'boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listing = await client.listTools();
  assert.ok(listing.tools.some(tool => tool.name === 'search_cases'));
  assert.ok(listing.tools.some(tool => tool.name === 'get_coverage_report'));
  assert.ok(listing.tools.some(tool => tool.name === 'list_court_sources'));
  assert.ok(!listing.tools.some(tool => tool.name === 'list_sources'));
  assert.ok(!listing.tools.some(tool => tool.name === 'request_case_acquisition'));
  const sources = await client.callTool({ name: 'list_court_sources', arguments: {} });
  assert.notEqual(sources.isError, true);
  const invalid = await client.callTool({ name: 'search_cases', arguments: { limit: 101 } });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 0);
  const result = await client.callTool({ name: 'search_cases', arguments: { q: 'housing', limit: 5 } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [{ q: 'housing', limit: 5, offset: 0 }]);
});

test('MCP acquire credentials expose acquisition but not administrator tools', async t => {
  const service = {} as InterfaceService;
  const server = createMcpServer(service, { env: { API_TOKEN_READ: 'read', API_TOKEN_WRITE: 'write', API_TOKEN_ADMIN: 'admin', MCP_ROLE: 'acquire', MCP_TOKEN: 'write' } });
  const client = new Client({ name: 'acquire-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(b); await client.connect(a);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'request_case_acquisition'));
  assert.ok(tools.some(tool => tool.name === 'request_bulk_search'));
  assert.ok(tools.some(tool => tool.name === 'request_case_refresh'));
  assert.ok(!tools.some(tool => ['list_sources', 'request_acquisition', 'request_bulk', 'request_refresh'].includes(tool.name)));
  assert.ok(!tools.some(tool => tool.name === 'retry_job'));
  assert.ok(!tools.some(tool => tool.name === 'import_legacy'));
});
