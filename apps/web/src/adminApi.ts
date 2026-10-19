import { fetchEnvelope } from './api';

export interface SystemSettings {
  public_web_url: string | null;
  public_api_url: string | null;
  revision: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface AdminTeam {
  team_code: string; name: string; owner_code: string | null; owner_name: string | null;
  created_by_code: string | null; created_by_name: string | null; ownership_pending: boolean;
  created_at: string; members_count: number; projects_count: number;
}

export interface AdminProject {
  project_code: string; team_code: string; team_name: string; name: string; description: string | null;
  status: 'active' | 'archived'; member_policy: string; owner_code: string | null; owner_name: string | null;
  created_by_code: string | null; created_by_name: string | null; ownership_pending: boolean;
  created_at: string; current_snapshot: number; members_count: number;
}

export interface AdminPage<T> { items: T[]; next_cursor: string | null; total: number }
export const getSystemSettings = (): Promise<SystemSettings> => fetchEnvelope('/admin/settings');
export const updateSystemSettings = (input: { public_web_url: string | null; public_api_url: string | null; base_revision: number }): Promise<SystemSettings> => fetchEnvelope('/admin/settings', { method: 'PUT', body: JSON.stringify(input) });
export function adminListTeams(input: { q?: string; cursor?: string } = {}): Promise<AdminPage<AdminTeam>> {
  return fetchEnvelope(`/admin/teams?${new URLSearchParams({ limit: '50', ...input })}`);
}
export function adminListProjects(input: { q?: string; cursor?: string; team_code?: string; status?: string } = {}): Promise<AdminPage<AdminProject>> {
  return fetchEnvelope(`/admin/projects?${new URLSearchParams({ limit: '50', ...input })}`);
}
export const adminUpdateTeam = (code: string, input: { name: string; reason: string }): Promise<unknown> => fetchEnvelope(`/admin/teams/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(input) });
export const adminUpdateProject = (code: string, input: { name: string; description: string | null; status: 'active' | 'archived'; reason: string; base_snapshot: number }): Promise<unknown> => fetchEnvelope(`/admin/projects/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(input) });
export const enableUser = (code: string): Promise<unknown> => fetchEnvelope(`/users/${encodeURIComponent(code)}/enable`, { method: 'POST', body: '{}' });
