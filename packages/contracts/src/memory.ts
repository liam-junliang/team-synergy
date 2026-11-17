import { z } from 'zod';
import { PublicCodeSchema } from './schemas.js';

const hostKey = z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/);
export const MemoryBindingQuery = z.object({
  topicCode: PublicCodeSchema,
  requirementCode: PublicCodeSchema,
}).strict();

/** The device provides a source turn and its previously observed binding.
 * The server derives actor, destinations, state and publication eligibility. */
export const MemoryCaptureInput = z.object({
  topicCode: PublicCodeSchema.optional(),
  requirementCode: PublicCodeSchema.optional(),
  sessionId: hostKey,
  eventId: hostKey,
  expectedRevision: z.number().int().positive().safe().optional(),
  expectedHead: PublicCodeSchema.nullable().optional(),
  sourceText: z.string().min(1).max(4000),
  referenceText: z.string().min(1).max(1000).optional(),
}).strict().refine(value => {
  const count = [value.topicCode, value.requirementCode, value.expectedRevision, value.expectedHead].filter(item => item !== undefined).length;
  return count === 0 || count === 4;
}, '议题、需求及其版本必须完整提供或全部省略');
export type MemoryCaptureInput = z.infer<typeof MemoryCaptureInput>;
export const PersonalMemoryListQuery = z.object({ projectCode: PublicCodeSchema.optional(),
  status: z.enum(['active', 'withdrawn', 'all']).optional() }).strict();
const memoryReason = z.string().trim().min(1).max(1000).optional();
export const PersonalMemoryEditInput = z.object({ expectedRevision: z.number().int().positive().safe(),
  text: z.string().trim().min(1).max(4000), reason: memoryReason }).strict();
export const PersonalMemoryWithdrawInput = z.object({ expectedRevision: z.number().int().positive().safe(), reason: memoryReason }).strict();
export interface PersonalMemoryRevisionView {
  source: string; revision: number; text: string; status: 'active' | 'withdrawn'; reason?: string; createdAt: string;
}
export interface PersonalMemoryView {
  /** Stable management identity; citations must use revisionSource. */
  source: string;
  revisionSource: string;
  revision: number;
  text: string;
  status: 'active' | 'withdrawn';
  applicability: 'account' | 'project';
  projectCode: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
  provenance: { receiptCode: string; sessionId: string; eventId: string };
  projection: { status: 'not_queued' | 'pending' | 'processing' | 'synced' | 'needs_reconcile';
    operation: 'upsert' | 'delete'; generation: number; cleanupPending: boolean; lastError?: string };
  history: PersonalMemoryRevisionView[];
}
export interface PersonalMemoryListView { items: PersonalMemoryView[]; truncated: boolean }
const MemoryScope = z.enum(['project', 'personal']);
export const MemoryBriefInput = z.object({ scope: MemoryScope }).strict();
export const MemorySourcesInput = z.object({
  sources: z.array(PublicCodeSchema).min(1).max(40),
}).strict();
export const MemoryDocumentReadInput = z.object({
  source: PublicCodeSchema,
  offset: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().min(2).max(8000).optional(),
  query: z.string().trim().min(1).max(256).optional(),
  occurrence: z.enum(['first', 'last']).optional(),
}).strict().refine(value => value.offset === undefined || value.query === undefined, '请选择分页位置或文档内查找之一')
  .refine(value => value.occurrence === undefined || value.query !== undefined, '匹配位置需要与query一起使用');
export const MemorySearchQuery = z.object({
  query: z.string().trim().min(1).max(256),
  scope: MemoryScope.optional(),
}).strict();

export type ProjectMemoryBindingState = 'not_enabled' | 'provisioning' | 'ready' | 'failed';
export type ProjectMemoryProjectionStatus = 'not_queued' | 'pending' | 'processing' | 'synced' | 'needs_reconcile';
export interface ProjectMemoryManagementView {
  projectCode: string;
  serviceConfigured: boolean;
  enabled: boolean;
  bindingState: ProjectMemoryBindingState;
  canManage: boolean;
  storage: 'native_pg';
  retrievalEnabled: boolean;
  counts: { total: number; pending: number; processing: number; synced: number; needsReconcile: number; notQueued: number };
  documents: Array<{
    documentCode: string;
    sourceKind?: 'project' | 'requirement' | 'architecture' | 'testing';
    path?: string;
    title: string;
    currentRevision: number;
    source: string;
    projectionStatus: ProjectMemoryProjectionStatus;
    lastError?: string;
  }>;
  documentsTruncated: boolean;
  updatedAt?: string;
  lastError?: string;
  legacyCleanupPending?: number;
}
