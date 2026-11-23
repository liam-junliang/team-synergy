import { fetchEnvelope } from './api';

export interface McpConnection {
  code: string;
  name: string;
  projectCode: string | null;
  allowPersonalMemory: boolean;
  allowTaskWrite: boolean;
  allowWorkspaceWrite?: boolean;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CreateMcpConnectionInput {
  name: string;
  allowPersonalMemory: boolean;
  allowTaskWrite: boolean;
  allowWorkspaceWrite?: boolean;
}

export interface NewMcpConnection {
  connection: McpConnection;
  token: string;
}

export interface McpAuthorizationRequest {
  clientName: string;
  redirectOrigin: string;
  requestedTaskWrite: boolean;
  requestedWorkspaceWrite?: boolean;
  requestedPersonalMemory: boolean;
}

export type McpAuthorizationDecision = { decision: 'deny' } | (Omit<CreateMcpConnectionInput, 'name'> & { decision: 'allow' });

function authorizationRequestPath(request: string): string {
  return `/mcp/oauth/requests/${encodeURIComponent(request)}`;
}

export function getMcpAuthorizationRequest(request: string, signal?: AbortSignal): Promise<McpAuthorizationRequest> {
  return fetchEnvelope(authorizationRequestPath(request), { signal, cache: 'no-store' });
}

export function decideMcpAuthorization(request: string, input: McpAuthorizationDecision): Promise<{ redirectUrl: string }> {
  return fetchEnvelope(authorizationRequestPath(request), { method: 'POST', body: JSON.stringify(input), cache: 'no-store' });
}

export function listMcpConnections(signal?: AbortSignal): Promise<McpConnection[]> {
  return fetchEnvelope('/account/mcp-connections', { signal, cache: 'no-store' });
}

export function createMcpConnection(input: CreateMcpConnectionInput): Promise<NewMcpConnection> {
  return fetchEnvelope('/account/mcp-connections', { method: 'POST', body: JSON.stringify(input), cache: 'no-store' });
}

export function revokeMcpConnection(code: string): Promise<unknown> {
  return fetchEnvelope(`/account/mcp-connections/${encodeURIComponent(code)}`, { method: 'DELETE', cache: 'no-store' });
}
