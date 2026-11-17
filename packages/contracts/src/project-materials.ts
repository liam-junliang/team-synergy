import { z } from 'zod';
import { PublicCodeSchema } from './schemas.js';

export const ProjectMaterialSourceKind = z.enum(['project', 'requirement', 'architecture', 'testing']);
export type ProjectMaterialSourceKind = z.infer<typeof ProjectMaterialSourceKind>;
const safePath = z.string().min(1).max(256).refine(value => !value.includes('\\') && !value.includes('\0') &&
  !value.startsWith('/') && !value.split('/').includes('..'), 'Use a relative virtual material path');
const selection = { sourceKinds: z.array(ProjectMaterialSourceKind).min(1).max(4).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active') };
const page = { offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(40) };
export const ProjectMaterialListInput = z.object({ ...selection, ...page, query: z.string().trim().min(1).max(256).optional() }).strict();
// Glob grammar is *, ?, ** and optional-directory **/. Paths are source-kind/code.md.
export const ProjectMaterialGlobInput = z.object({ ...selection, ...page, pattern: safePath }).strict();
export const ProjectMaterialGrepInput = z.object({ ...selection, ...page, pattern: z.string().min(1).max(256),
  pathGlob: safePath.optional(), mode: z.enum(['literal', 'regex']).default('literal'),
  caseSensitive: z.boolean().default(false), contextLines: z.number().int().min(0).max(5).default(1),
  maxChars: z.number().int().min(1000).max(32000).default(16000) }).strict();
export const ProjectMaterialReadInput = z.object({ sourceKind: ProjectMaterialSourceKind.optional(), objectCode: PublicCodeSchema.optional(),
  path: safePath.optional(), sourceCitation: PublicCodeSchema.optional(), revision: z.number().int().positive().safe().optional(),
  offset: z.number().int().nonnegative().max(100000000).optional(), limit: z.number().int().min(2).max(16000).default(4000),
  startLine: z.number().int().positive().max(1000000).optional(), endLine: z.number().int().positive().max(1000000).optional(),
}).strict().superRefine((value, ctx) => {
  const object = value.sourceKind !== undefined || value.objectCode !== undefined;
  if (Number(object) + Number(value.path !== undefined) + Number(value.sourceCitation !== undefined) !== 1 ||
      (object && (!value.sourceKind || !value.objectCode)) || (value.sourceCitation && value.revision !== undefined) ||
      (value.offset !== undefined && value.startLine !== undefined) || (value.endLine !== undefined && value.startLine === undefined) ||
      (value.startLine !== undefined && value.endLine !== undefined && (value.endLine < value.startLine || value.endLine - value.startLine > 500))) {
    ctx.addIssue({ code: 'custom', message: 'Choose one material locator and one valid character or line range' });
  }
});
export type ProjectMaterialListInput = z.input<typeof ProjectMaterialListInput>;
export type ProjectMaterialGlobInput = z.input<typeof ProjectMaterialGlobInput>;
export type ProjectMaterialGrepInput = z.input<typeof ProjectMaterialGrepInput>;
export type ProjectMaterialReadInput = z.input<typeof ProjectMaterialReadInput>;

export interface ProjectMaterialMetadata {
  sourceKind: ProjectMaterialSourceKind; objectCode: string; projectCode: string;
  path: string; title: string; titleTruncated: boolean; summary: string; revision: number; revisionCode: string;
  source: string; sourceCitation: string; metadataHash: string; status: 'active' | 'archived'; state: 'documented';
  summaryOrigin: 'authored' | 'excerpt' | 'title';
  contentType: string; textSearchable: boolean; updatedAt: string; folderCode: string | null;
}
export interface ProjectMaterialListView {
  items: ProjectMaterialMetadata[]; total: number; offset: number; nextOffset: number | null; truncated: boolean;
  catalogTruncated: boolean; pathGrammar: 'sourceKind/objectCode.md';
}
export interface ProjectMaterialReadView extends ProjectMaterialMetadata {
  body: string | null; current: boolean; version: { revision: number; revisionCode: string; sha256: string | null };
  range: { offset: number; nextOffset: number | null; totalChars: number; startLine: number; endLine: number; totalLines: number; unit: 'utf16' } | null;
  truncated: boolean; unsupportedReason?: 'binary_content';
}
export interface ProjectMaterialGrepMatch {
  sourceKind: ProjectMaterialSourceKind; objectCode: string; path: string; title: string; source: string; sourceCitation: string;
  revision: number; revisionCode: string; line: number; column: number; text: string;
  context: Array<{ line: number; text: string }>; textTruncated: boolean;
}
export interface ProjectMaterialGrepView {
  matches: ProjectMaterialGrepMatch[]; offset: number; nextOffset: number | null; truncated: boolean;
  scannedDocuments: number; skippedBinary: number; skippedOversize: number; catalogTruncated: boolean;
  limits: { maxDocuments: number; maxInputChars: number; maxOutputChars: number; timeoutMs: number };
}
