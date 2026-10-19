import { z } from 'zod';
import { PublicCodeSchema, TaskContractSchema } from './schemas.js';

const summaryItems = () => z.array(z.string().max(4000)).max(100).default([]);
const gitObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const portablePath = z.string().min(1).max(4096).refine(
  (value) => !/^(?:[a-zA-Z]:|[/\\])/.test(value)
    && !value.includes('\\')
    && !value.split('/').some((part) => part === '..' || part === '' || part === '.')
    && ![...value].some(character => character.charCodeAt(0) < 32),
  '路径必须为无穿越的仓库相对路径',
);

/** Explicitly published working notes, independent of provider-native conversations. */
export const HandoverSummarySchema = z.object({
  goal: z.string().min(1).max(4000),
  completed: summaryItems(),
  remaining: summaryItems(),
  decisions_applied: summaryItems(),
  assumptions: summaryItems(),
  open_questions: summaryItems(),
  failed_attempts: summaryItems(),
  next_actions: summaryItems(),
  evidence_refs: z.array(z.string().max(1000)).max(100).default([]),
}).strict();
export type HandoverSummary = z.infer<typeof HandoverSummarySchema>;

/** A portable manifest never contains a source machine's absolute workspace path. */
export const WorkspaceManifestSchema = z.object({
  repository_code: PublicCodeSchema,
  remote_url: z.string().min(1).max(4096),
  base_commit: gitObjectId,
  snapshot_commit: gitObjectId,
  snapshot_tree: gitObjectId,
  snapshot_ref: z.string().min(1).max(1024),
  files: z.array(z.object({ path: portablePath, hash: z.string().max(128).optional() }).strict()).max(10000).optional(),
  required_artifacts: z.array(z.object({
    kind: z.enum(['inline', 'git']),
    path: portablePath.optional(),
    content: z.string().max(262144).optional(),
    hash: z.string().max(128).optional(),
  }).strict().superRefine((artifact, ctx) => {
    if (artifact.kind === 'git' && !artifact.path) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'Git 材料需要相对路径' });
    }
    if (artifact.kind === 'inline' && artifact.content === undefined) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: '内联材料需要正文' });
    }
  })).max(100).optional(),
}).strict();
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

/** Versioned JSON boundary; application use cases assemble and validate each source. */
export const ContextManifestSchema = z.object({
  schema_version: z.literal(1),
  task_contract: TaskContractSchema.passthrough(),
  sources: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
}).passthrough();
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

export const HandoverStatusSchema = z.enum([
  'preparing', 'published', 'accepted', 'restoring', 'ready',
  'completed', 'cancelled', 'expired',
]);
export type HandoverStatus = z.infer<typeof HandoverStatusSchema>;
