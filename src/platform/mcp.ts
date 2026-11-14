import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplication } from './bootstrap.js';
import { authorize, invokeOperation, MAX_BODY_BYTES, operations, publicError, resolveMcpRole, type Environment, type InterfaceService } from './interfaces.js';

const externalToolNames: Record<string, string> = {
  list_sources: 'list_court_sources',
  request_acquisition: 'request_case_acquisition',
  request_bulk: 'request_bulk_search',
  request_refresh: 'request_case_refresh',
};

export interface McpOptions { env?: Environment; }
export function createMcpServer(service: InterfaceService, options: McpOptions = {}): McpServer {
  const role = resolveMcpRole(options.env ?? process.env);
  const server = new McpServer({ name: 'court-evidence', version: '1.0.0' });
  for (const [name, definition] of Object.entries(operations)) {
    try { authorize(role, definition.role); } catch { continue; }
    server.registerTool(externalToolNames[name] ?? name, {
      description: definition.description,
      inputSchema: definition.schema,
      annotations: { readOnlyHint: definition.role === 'read',
        destructiveHint: name === 'restrict_case' || name === 'cancel_job' || name.includes('retention'),
        idempotentHint: definition.role === 'read' || name.startsWith('request_') || name === 'set_case_watch' || name === 'set_refresh_policy',
        openWorldHint: definition.role !== 'read' },
    }, async input => {
      try {
        const result = await invokeOperation(service, name, input, role, `mcp:${role}`);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        const failure = publicError(error);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure.error }) }] };
      }
    });
  }
  return server;
}

export async function main(): Promise<void> {
  resolveMcpRole();
  const application = await createApplication();
  const server = createMcpServer(application.service);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_BODY_BYTES + 65536 });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(() => server.close()).finally(() => application.close());
    return closing;
  };
  const stop = () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); };
  server.server.onclose = stop;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await server.connect(transport); }
  catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
