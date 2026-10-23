import { fetchEnvelope, type HandoffDocumentSummary } from './api';
import type { SystemAgentJobView as SystemAgentJob } from '../../../packages/contracts/src/system-agent';
export type { SystemAgentJobView as SystemAgentJob, SystemAgentJobStatus, SystemAgentProposal } from '../../../packages/contracts/src/system-agent';
export interface SystemAgentStatus { configured: boolean; engine: string; version: string; message: string }
export interface SystemAgentTarget { project_code: string; document_code: string; title: string; base_revision: number; quote?: string }
export interface SystemAgentCreateInput { document_code: string; base_revision: number; instruction: string; quote?: string; request_key: string }

const jobPath = (code: string) => `/system-agent/jobs/${encodeURIComponent(code)}`;
export const getSystemAgentStatus = (): Promise<SystemAgentStatus> => fetchEnvelope('/system-agent/status');
export const listSystemAgentJobs = (project: string): Promise<SystemAgentJob[]> => fetchEnvelope(`/projects/${encodeURIComponent(project)}/system-agent/jobs`);
export const getSystemAgentJob = (code: string): Promise<SystemAgentJob> => fetchEnvelope(jobPath(code));
export const createSystemAgentJob = (project: string, input: SystemAgentCreateInput): Promise<SystemAgentJob> => fetchEnvelope(`/projects/${encodeURIComponent(project)}/system-agent/jobs`, { method: 'POST', body: JSON.stringify(input) });
export const cancelSystemAgentJob = (code: string): Promise<SystemAgentJob> => fetchEnvelope(`${jobPath(code)}/cancel`, { method: 'POST', body: '{}' });
export const rejectSystemAgentJob = (code: string): Promise<SystemAgentJob> => fetchEnvelope(`${jobPath(code)}/reject`, { method: 'POST', body: '{}' });
export const applySystemAgentJob = (code: string, input: { proposal_hash: string; base_revision: number }): Promise<SystemAgentJob> => fetchEnvelope(`${jobPath(code)}/apply`, { method: 'POST', body: JSON.stringify(input) });

export const SYSTEM_AGENT_OPEN_EVENT = 'tsp:system-agent-open';
export function openSystemAgent(target: SystemAgentTarget): void {
  window.dispatchEvent(new CustomEvent<SystemAgentTarget>(SYSTEM_AGENT_OPEN_EVENT, { detail: target }));
}
export function systemAgentDocumentEligible(document: HandoffDocumentSummary): boolean {
  return document.source_kind === 'project' && document.status === 'active' && document.can_edit;
}
export function systemAgentJobActive(job: Pick<SystemAgentJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}
export function systemAgentCanApply(job: SystemAgentJob): boolean {
  return job.status === 'awaiting_review' && job.can_apply && Boolean(job.proposal && job.proposal_hash);
}

export interface SystemAgentDraft { target: SystemAgentTarget | null; instruction: string; request_key: string; selected_job: string | null }
/** Explicit new work gets a fresh identity; an uncertain network retry retains the saved draft identity. */
export function newSystemAgentDraft(instruction: string, requestKey: string): SystemAgentDraft {
  return { target: null, instruction, request_key: requestKey, selected_job: null };
}
export function readSystemAgentDraft(storage: Pick<Storage, 'getItem'> | undefined, key: string, project: string): SystemAgentDraft {
  const empty: SystemAgentDraft = { target: null, instruction: '', request_key: '', selected_job: null };
  try {
    const value = JSON.parse(storage?.getItem(key) ?? 'null') as Partial<SystemAgentDraft> | null;
    if (!value || typeof value.instruction !== 'string' || typeof value.request_key !== 'string') return empty;
    const target = value.target;
    if (target && (target.project_code !== project || typeof target.document_code !== 'string' || typeof target.title !== 'string' || !Number.isInteger(target.base_revision) || target.base_revision < 1 || (target.quote !== undefined && typeof target.quote !== 'string'))) return empty;
    return { target: target ?? null, instruction: value.instruction, request_key: value.request_key, selected_job: typeof value.selected_job === 'string' ? value.selected_job : null };
  } catch { return empty; }
}

export function exactSystemAgentQuote(content: string, selection: string): string | null {
  const quote = selection.trim();
  return quote && quote.length <= 20_000 && content.includes(quote) ? quote : null;
}

export interface SystemAgentDiffLine { kind: 'same' | 'removed' | 'added'; text: string; before?: number; after?: number }
/** Exact line diff. Large changed blocks use a bounded replacement without hiding any content. */
export function systemAgentLineDiff(before: string, after: string): SystemAgentDiffLine[] {
  const a = before.split('\n'); const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const result: SystemAgentDiffLine[] = a.slice(0, prefix).map((text, index) => ({ kind: 'same', text, before: index + 1, after: index + 1 }));
  const aa = a.slice(prefix, a.length - suffix); const bb = b.slice(prefix, b.length - suffix);
  if ((aa.length + 1) * (bb.length + 1) <= 1_000_000) {
    const width = bb.length + 1; const grid = new Uint32Array((aa.length + 1) * width);
    for (let i = aa.length - 1; i >= 0; i--) for (let j = bb.length - 1; j >= 0; j--) grid[i * width + j] = aa[i] === bb[j] ? grid[(i + 1) * width + j + 1] + 1 : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1]);
    let i = 0; let j = 0;
    while (i < aa.length || j < bb.length) {
      if (i < aa.length && j < bb.length && aa[i] === bb[j]) { result.push({ kind: 'same', text: aa[i], before: prefix + i + 1, after: prefix + j + 1 }); i++; j++; }
      else if (i < aa.length && (j === bb.length || grid[(i + 1) * width + j] >= grid[i * width + j + 1])) { result.push({ kind: 'removed', text: aa[i], before: prefix + i + 1 }); i++; }
      else { result.push({ kind: 'added', text: bb[j], after: prefix + j + 1 }); j++; }
    }
  } else {
    result.push(...aa.map((text, i): SystemAgentDiffLine => ({ kind: 'removed', text, before: prefix + i + 1 })), ...bb.map((text, i): SystemAgentDiffLine => ({ kind: 'added', text, after: prefix + i + 1 })));
  }
  for (let i = suffix; i > 0; i--) result.push({ kind: 'same', text: a[a.length - i], before: a.length - i + 1, after: b.length - i + 1 });
  return result;
}
