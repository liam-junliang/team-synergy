import { fetchEnvelope } from './api';
import { ApiError } from './apiError';
import type { PersonalMemoryListView, PersonalMemoryView } from '../../../packages/contracts/src/memory';

export type { PersonalMemoryListView, PersonalMemoryView } from '../../../packages/contracts/src/memory';
export type PersonalMemoryFilter = 'active' | 'withdrawn' | 'all';
export type PersonalMemoryEdit = { expectedRevision: number; text: string; reason?: string };
export type PersonalMemoryWithdraw = { expectedRevision: number; reason?: string };
export const personalMemoryQueryKey = (owner: string) => ['personal-memory', owner] as const;
export const personalMemoryListKey = (owner: string, status: PersonalMemoryFilter, project?: string) => [...personalMemoryQueryKey(owner), 'list', status, project ?? ''] as const;
export const personalMemoryDetailKey = (owner: string, source: string) => [...personalMemoryQueryKey(owner), 'detail', source] as const;
const base = '/memory/personal';
const location = (source: string) => `${base}/${encodeURIComponent(source)}`;

function checked(value: PersonalMemoryView, source: string): PersonalMemoryView {
  if (!value || value.source !== source) throw new ApiError('memory_source_mismatch', '记忆详情与所选记录不一致，请重新读取。', 502);
  return value;
}

export function listPersonalMemory(status: PersonalMemoryFilter = 'active', projectCode?: string) {
  const query = new URLSearchParams({ status });
  if (projectCode) query.set('projectCode', projectCode);
  return fetchEnvelope<PersonalMemoryListView>(`${base}?${query}`);
}
export async function getPersonalMemory(source: string) {
  return checked(await fetchEnvelope<PersonalMemoryView>(location(source)), source);
}
export async function editPersonalMemory(source: string, input: PersonalMemoryEdit) {
  return checked(await fetchEnvelope<PersonalMemoryView>(location(source), { method: 'PATCH', body: JSON.stringify(input) }), source);
}
export async function withdrawPersonalMemory(source: string, input: PersonalMemoryWithdraw) {
  return checked(await fetchEnvelope<PersonalMemoryView>(location(source) + '/withdraw', { method: 'POST', body: JSON.stringify(input) }), source);
}
export function personalMemoryConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}
