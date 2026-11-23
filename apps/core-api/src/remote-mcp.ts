import { Readable } from 'node:stream';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import { toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';
import type { FastifyInstance } from 'fastify';
import { connectorReadPrincipal } from './auth.js';
import { workspaceActionExecutor } from './agent-workspace-actions.js';
import { resolveRemoteMcpGrant, type RemoteMcpGrant } from './remote-mcp-authorization.js';
import { remoteMcpResourceMetadataUrl } from './remote-mcp-oauth.js';
import { remoteMcpTools, type RemoteMcpRequest } from './remote-mcp-tools.js';

const path = '/mcp';
const methods = ['GET', 'POST', 'DELETE'] as const;
const publicReads = new Set(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/mcp/oauth/authorize']);
const tokenMethods = new Set(['/mcp/oauth/register', '/mcp/oauth/token']);

export function isPublicConnectorRoute(method: string, pathname: string): boolean {
  return (pathname === path && methods.some(candidate => candidate === method)) ||
    (method === 'GET' && publicReads.has(pathname)) || ((method === 'POST' || method === 'OPTIONS') && tokenMethods.has(pathname));
}

export function configuredRemoteMcpUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.TSP_REMOTE_MCP_URL?.trim();
  if (!value) return;
  const resource = new URL(value);
  const production = env.NODE_ENV === 'production' || env.ACP_ENV === 'production';
  const localHttp = !production && resource.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(resource.hostname);
  if ((resource.protocol !== 'https:' && !localHttp) || resource.username || resource.password ||
      resource.search || resource.hash || resource.pathname !== '/api/mcp' ||
      (env.TSP_WEB_ORIGIN && new URL(env.TSP_WEB_ORIGIN).origin !== resource.origin)) {
    throw new Error('TSP_REMOTE_MCP_URL must be the same-origin public HTTPS URL ending in /api/mcp');
  }
  return resource.href;
}

function memoryReader(app: FastifyInstance, grant: RemoteMcpGrant): RemoteMcpRequest {
  return async ({ projectCode, ...options }) => {
    if (grant.projectCode !== null && projectCode !== grant.projectCode) {
      return { ok: false, error: { code: 'connector_project_forbidden', message: 'Project is outside the connection authorization.' } };
    }
    const scope = (options.payload as { scope?: unknown } | undefined)?.scope;
    const readsMemory = !options.url.endsWith('/documents/read');
    if (readsMemory && scope !== 'project' && !(scope === 'personal' && grant.allowPersonalMemory)) {
      return { ok: false, error: { code: 'connector_scope_forbidden', message: 'Memory scope is outside the connection authorization.' } };
    }
    class ConnectorRequest extends Readable {}
    Object.defineProperty(ConnectorRequest.prototype, connectorReadPrincipal, {
      value: { principalCode: grant.principalCode, projectCode },
    });
    const response = await app.inject({ ...options, Request: ConnectorRequest });
    return response.json();
  };
}

const instructions = 'For first use or workflow guidance, call read_connector_skill with {} on this connection. Call it with module for detailed tool usage and examples in that module. ' +
  'To choose the operation, call search_tools with {} for module guides or use module/query to find specific tools. ' +
  'If the user names a project, resolve it with list_projects, then pass its projectCode to search_tools and the chosen tools on this same connection. Project codes are scoped to the platform connection that returned them. Ask when a write target is ambiguous. ' +
  'Reuse tool choices and evidence already retrieved. Cite sources and distinguish discussed, confirmed, and implemented. Check permissions and task state before changes.';

export function registerRemoteMcp(app: FastifyInstance, db: Db, resourceUrl: string): void {
  const resource = new URL(resourceUrl);
  const metadata = remoteMcpResourceMetadataUrl(resourceUrl);
  const executeWorkspace = workspaceActionExecutor(app, db);
  app.route({ method: [...methods], url: path, logLevel: 'silent', bodyLimit: 128 * 1024,
    onRequest: hostHeaderValidation([resource.hostname]),
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.headers.origin !== undefined && request.headers.origin !== resource.origin) {
        return reply.code(403).send({ error: 'invalid_origin' });
      }
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
      const grant = bearer?.[1] ? await resolveRemoteMcpGrant(db, bearer[1], resourceUrl) : null;
      if (!grant) {
        reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"${bearer ? ', error="invalid_token"' : ''}`);
        return reply.code(401).send({ error: bearer ? 'invalid_token' : 'authorization_required' });
      }

      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: 'team-synergy', version: '0.1.0' }, { instructions });
        for (const tool of remoteMcpTools(db, grant, memoryReader(app, grant), resource.origin, executeWorkspace)) {
          server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema, annotations: tool.annotations },
            async (args: unknown) => {
              try {
                const result = await tool.execute(args);
                const data = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { data: result };
                return { isError: false, structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
              } catch (error) {
                const details = error instanceof DomainError ? { code: error.code, message: error.message }
                  : { code: 'internal_error', message: 'TeamSynergy could not complete this request.' };
                return { isError: true, structuredContent: { error: details }, content: [{ type: 'text' as const, text: JSON.stringify(details) }] };
              }
            });
        }
        return server;
      }, { legacy: 'stateless' });
      const abort = new AbortController();
      const onClose = () => { if (!reply.raw.writableFinished) abort.abort(); };
      reply.raw.once('close', onClose);
      const response = await handler.fetch(await toWebRequest(request.raw, request.body, { signal: abort.signal }), { parsedBody: request.body });
      for (const [key, value] of response.headers) reply.header(key, value);
      reply.header('Cache-Control', 'no-store');
      reply.code(response.status);
      return reply.send(response.body ? Readable.fromWeb(response.body) : undefined);
    },
  });
}
