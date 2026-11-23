import { code, type AgentActionDefinition, type AgentProjectRole } from './agent-action-definition.js';
import { governanceActions } from './agent-governance-actions.js';
import { projectActions } from './agent-project-actions.js';

export * from './agent-action-definition.js';

export const agentWorkspaceActions: readonly AgentActionDefinition[] = [...governanceActions, ...projectActions];
export const agentWorkspaceActionByName = (name: string) => agentWorkspaceActions.find(action => action.name === name);
export const agentWorkspaceRoleAllows = (action: AgentActionDefinition, role: AgentProjectRole) =>
  (action.method === 'GET' || role !== 'viewer') && (!action.roles || action.roles.includes(role));
export const agentWorkspaceInputSchema = (action: AgentActionDefinition, fixedProject?: string | null) =>
  action.scope === 'account' ? action.schema : action.schema.safeExtend({
    projectCode: fixedProject ? code.optional() : code.describe('使用 list_projects 返回的目标项目编码'),
  });

export function agentWorkspaceRequest(action: AgentActionDefinition, input: Record<string, unknown>) {
  const data = { ...input };
  const path = action.path.replace(/:([a-zA-Z_]+)/g, (_placeholder, key: string) => {
    const value = data[key];
    if (typeof value !== 'string' || !value) throw new Error('Missing validated path parameter ' + key);
    if (!action.bodyPathKeys?.includes(key)) delete data[key];
    return encodeURIComponent(value);
  });
  delete data.projectCode;
  if (action.projectArgument) data[action.projectArgument] = input.projectCode;
  if (action.method !== 'GET') return { method: action.method, url: path, ...(Object.keys(data).length ? { payload: data } : {}) };
  const query = Object.entries(data).filter(([, value]) => value !== undefined)
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value))).join('&');
  return { method: action.method, url: query ? path + '?' + query : path };
}
