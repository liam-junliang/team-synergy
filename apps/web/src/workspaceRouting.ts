export const PROJECT_SECTIONS = ['overview', 'documents', 'plan', 'requirements', 'design', 'board', 'testing', 'defects', 'handovers'] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];
export type WorkspaceView = 'teams' | 'account' | 'agent' | 'admin' | ProjectSection;
export type AdminSection = 'teams' | 'users' | 'settings';
export type ProjectWorkspaceTab = 'overview' | 'structure' | 'architecture' | 'intake';

export interface WorkspaceRoute {
  view: WorkspaceView;
  projectCode?: string;
  documentCode?: string;
  folderCode?: string;
  createDocument?: boolean;
  handoverCode?: string;
  projectTab?: ProjectWorkspaceTab;
  requirementsTab?: 'ideas' | 'topics' | 'documents' | 'checklist';
  testingTab?: 'cases' | 'assets' | 'executions';
  testingCode?: string;
  agentTab?: 'connect' | 'skills' | 'authorize';
  authorizationCode?: string;
  teamCode?: string;
  agentReturnPath?: string;
  adminTab?: AdminSection;
}

export function parseWorkspacePath(pathname: string): WorkspaceRoute {
  const [path, query = ''] = pathname.split('#', 1)[0].split('?');
  const parts = (path ?? '').split('/').filter(Boolean);
  if (parts[0] === 'admin') {
    return { view: 'admin', adminTab: parts[1] === 'settings' || parts[1] === 'users' ? parts[1] : 'teams' };
  }
  if (parts[0] === 'agent' && parts[1] === 'authorize') {
    const code = new URLSearchParams(query).get('code')?.trim().toUpperCase();
    return { view: 'agent', agentTab: 'authorize', ...(code ? { authorizationCode: code.slice(0, 32) } : {}) };
  }
  if (parts[0] === 'agent' && (parts[1] === 'connect' || parts[1] === 'skills')) {
    const params = new URLSearchParams(query);
    const projectCode = params.get('project') || undefined;
    const teamCode = params.get('team') || undefined;
    const returnPath = params.get('return');
    return { view: 'agent', agentTab: parts[1], ...(projectCode ? { projectCode } : {}), ...(teamCode ? { teamCode } : {}),
      ...(returnPath && safeAgentReturnPath(returnPath, projectCode) === returnPath ? { agentReturnPath: returnPath } : {}) };
  }
  if (parts[0] === 'projects' && parts[1]) {
    let projectCode: string;
    try { projectCode = decodeURIComponent(parts[1]); } catch { return { view: 'teams' }; }
    if (parts[2] === 'baselines') {
      return { view: 'requirements', projectCode, requirementsTab: 'documents' };
    }
    const section = PROJECT_SECTIONS.includes(parts[2] as ProjectSection) ? parts[2] as ProjectSection : 'overview';
    const route: WorkspaceRoute = { view: section, projectCode };
    if (section === 'testing') {
      const params = new URLSearchParams(query);
      const tab = params.get('tab');
      route.testingTab = tab === 'assets' || tab === 'executions' ? tab : 'cases';
      const itemCode = params.get('item');
      if (itemCode) route.testingCode = itemCode;
    }
    if (section === 'overview') {
      const params = new URLSearchParams(query);
      const tab = params.get('tab');
      const documentCode = params.get('document');
      if (tab === 'structure' || tab === 'architecture' || tab === 'intake') route.projectTab = tab;
      if (tab === 'architecture' && documentCode) route.documentCode = documentCode;
    }
    if (section === 'documents') {
      const params = new URLSearchParams(query);
      const documentCode = params.get('document');
      const folderCode = params.get('folder');
      if (documentCode) route.documentCode = documentCode;
      if (folderCode) route.folderCode = folderCode;
      if (folderCode && params.get('create') === 'document') route.createDocument = true;
    }
    if (section === 'handovers') {
      const handoverCode = new URLSearchParams(query).get('handover');
      if (handoverCode) route.handoverCode = handoverCode;
    }
    if (section === 'requirements') {
      const params = new URLSearchParams(query);
      const documentCode = params.get('document');
      const tab = params.get('tab');
      if (tab === 'structure') return { view: 'overview', projectCode, projectTab: 'structure' };
      route.requirementsTab = tab === 'topics'
        ? 'topics'
        : tab === 'documents'
          ? 'documents'
          : tab === 'checklist' || tab === 'table'
            ? 'checklist'
            : 'ideas';
      if (documentCode) {
        route.documentCode = documentCode;
        if (!tab) route.requirementsTab = 'documents';
      }
    }
    return route;
  }
  if (parts[0] === 'account') return { view: 'account' };
  return { view: 'teams' };
}

export function projectWorkspacePath(projectCode: string, section: ProjectSection = 'overview'): string {
  return `/projects/${encodeURIComponent(projectCode)}/${section}`;
}

export function safeAgentReturnPath(path?: string | null, projectCode?: string): string {
  if (path?.startsWith('/') && !path.startsWith('//') && !path.startsWith('/agent/') && !path.includes('\\') && isWorkspacePath(path)) {
    const route = parseWorkspacePath(path);
    if (route.view !== 'agent' && (!projectCode || route.projectCode === projectCode)) return path;
  }
  return projectCode ? projectWorkspacePath(projectCode) : '/teams';
}

export function agentWorkspacePath(tab: 'connect' | 'skills' = 'connect', context: { projectCode?: string; teamCode?: string; agentReturnPath?: string } = {}): string {
  const params = new URLSearchParams();
  if (context.projectCode) params.set('project', context.projectCode);
  if (context.teamCode) params.set('team', context.teamCode);
  if (context.agentReturnPath) params.set('return', safeAgentReturnPath(context.agentReturnPath, context.projectCode));
  return `/agent/${tab}${params.size ? `?${params}` : ''}`;
}

export function testingWorkspacePath(projectCode: string, tab: 'cases' | 'assets' | 'executions' = 'cases', code?: string): string {
  const params = new URLSearchParams({ tab });
  if (code) params.set('item', code);
  return `${projectWorkspacePath(projectCode, 'testing')}?${params}`;
}

export function projectHomeWorkspacePath(projectCode: string, tab: ProjectWorkspaceTab = 'overview', documentCode?: string): string {
  const params = new URLSearchParams();
  if (tab !== 'overview') params.set('tab', tab);
  if (tab === 'architecture' && documentCode) params.set('document', documentCode);
  return `${projectWorkspacePath(projectCode)}${params.size ? `?${params.toString()}` : ''}`;
}

/** Keep old functional-module bookmarks, including query context and heading fragments. */
export function migratedProjectStructurePath(path: string): string | null {
  const url = new URL(path, 'https://workspace.invalid');
  if (!/^\/projects\/[^/]+\/requirements\/?$/.test(url.pathname) || url.searchParams.get('tab') !== 'structure') return null;
  if (!isWorkspacePath(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/requirements\/?$/, '/overview');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function projectDocumentWorkspacePath(projectCode: string, documentCode: string): string {
  return `${projectWorkspacePath(projectCode, 'documents')}?${new URLSearchParams({ document: documentCode }).toString()}`;
}

export function projectFolderWorkspacePath(projectCode: string, folderCode: string, createDocument = false): string {
  const params = new URLSearchParams({ folder: folderCode });
  if (createDocument) params.set('create', 'document');
  return `${projectWorkspacePath(projectCode, 'documents')}?${params.toString()}`;
}

export function requirementWorkspacePath(projectCode: string, options: { documentCode?: string; tab?: 'ideas' | 'topics' | 'documents' | 'checklist' | 'structure' } = {}): string {
  if (options.tab === 'structure') return projectHomeWorkspacePath(projectCode, 'structure');
  const params = new URLSearchParams();
  if (options.tab && options.tab !== 'ideas') params.set('tab', options.tab);
  if (options.documentCode && !options.tab) params.set('tab', 'documents');
  if (options.documentCode) params.set('document', options.documentCode);
  const query = params.size ? `?${params.toString()}` : '';
  return `${projectWorkspacePath(projectCode, 'requirements')}${query}`;
}

/** Recognize UI locations exactly; never swallow API, asset or download paths. */
export function isWorkspacePath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  if (/^\/(?:teams\/?|account\/?)?$/.test(pathname)) return true;
  if (/^\/agent\/(?:connect|skills|authorize)\/?$/.test(pathname)) return true;
  if (/^\/admin(?:\/(?:teams|users|settings))?\/?$/.test(pathname)) return true;
  const match = /^\/projects\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return false;
  try { decodeURIComponent(match[1]); } catch { return false; }
  return !match[2] || PROJECT_SECTIONS.includes(match[2] as ProjectSection)
    || ['baselines', 'orchestration', 'acceptance'].includes(match[2]);
}

export function legacyWorkspacePath(hash: string): string | null {
  const path = hash.startsWith('#/') ? hash.slice(1) : '';
  return isWorkspacePath(path) ? path : null;
}

export function workspaceShareUrl(path: string, baseUrl: string): string {
  return new URL(path, baseUrl).href;
}

export function workspacePathAfterLogin(href: string, isSystemAdmin: boolean): string {
  const location = new URL(href);
  const legacy = legacyWorkspacePath(location.hash);
  if (legacy) return isSystemAdmin && parseWorkspacePath(legacy).view === 'teams' ? '/admin/teams' : legacy;
  if (isSystemAdmin && /^\/(?:teams\/?)?$/.test(location.pathname)) return '/admin/teams';
  if (location.pathname !== '/' && isWorkspacePath(location.pathname)) return `${location.pathname}${location.search}${location.hash}`;
  return isSystemAdmin ? '/admin/teams' : '/teams';
}
