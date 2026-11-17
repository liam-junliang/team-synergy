import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DomainError } from '@team-synergy/domain';
import { createApiClient, type ApiResult } from './api-client.js';
import { identifyBoundProject } from './project-binding.js';
import type { RemoteHandoffDocument, RemoteHandoffDocumentSummary, RemoteHandoffFolder } from './pack.js';

type ApiClient = ReturnType<typeof createApiClient>;

interface HandoffLibrary {
  folders?: RemoteHandoffFolder[];
  documents?: RemoteHandoffDocumentSummary[];
}

export interface GuidanceDocument {
  document_code: string;
  title: string;
  summary: string;
  revision: number;
  snapshot: string;
}

export interface GuidanceResult {
  project_code: string;
  workspace_root: string;
  generated_at: string;
  documents: GuidanceDocument[];
  code_repositories: string[];
}

export interface GuidanceCheckDocument {
  document_code: string;
  title: string;
  local_revision: number | null;
  remote_revision: number;
  stale: boolean;
}

export interface GuidanceCheckResult {
  project_code: string;
  up_to_date: boolean;
  manifest_generated_at: string | null;
  documents: GuidanceCheckDocument[];
}

interface GuidanceOptions {
  dir?: string;
  api?: ApiClient;
}

interface ResolvedWorkspace {
  workspaceRoot: string;
  projectCode: string;
  apiUrl: string;
}

function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  const details = typeof result.error.details === 'object' && result.error.details !== null
    ? result.error.details as Record<string, unknown>
    : undefined;
  throw new DomainError(result.error.code, result.error.message, details);
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, file);
}

function resolveWorkspace(dir?: string): ResolvedWorkspace {
  const identified = identifyBoundProject(path.resolve(dir ?? process.cwd()));
  if (!identified) {
    throw new DomainError('project_binding_not_found', '未找到 .agent/bound-project.yaml；请在工作区根目录执行');
  }
  return {
    workspaceRoot: path.dirname(path.dirname(identified.path)),
    projectCode: identified.binding.project_code,
    apiUrl: identified.binding.api_url,
  };
}

async function fetchStandards(api: ApiClient, projectCode: string): Promise<{
  folder: RemoteHandoffFolder;
  documents: RemoteHandoffDocument[];
}> {
  const library = unwrap(await api.listHandoffLibrary(projectCode)) as HandoffLibrary;
  const folder = (library.folders ?? []).find((item) => item.system_role === 'standards');
  if (!folder) {
    throw new DomainError('standards_folder_missing', '项目规范目录不存在或不可读');
  }
  const active = (library.documents ?? []).filter((item) => (
    item.folder_code === folder.folder_code && item.status === 'active'
  ));
  if (active.length === 0) {
    throw new DomainError('standards_empty', '项目规范目录没有有效文档');
  }
  const documents: RemoteHandoffDocument[] = [];
  for (const summary of active) {
    const detail = unwrap(await api.getHandoffDocument(summary.document_code)) as unknown as RemoteHandoffDocument;
    if (!detail.content) {
      throw new DomainError('standard_content_missing', `规范 ${summary.document_code} 没有正文`);
    }
    documents.push(detail);
  }
  return { folder, documents };
}

function renderAgents(input: {
  projectCode: string;
  apiUrl: string;
  generatedAt: string;
  entries: GuidanceDocument[];
  contents: Map<string, string>;
}): string {
  const lines: string[] = [
    '# Team Synergy workspace guidance',
    '',
    `> Generated from the platform project standards for project \`${input.projectCode}\`.`,
    `> Generated at ${input.generatedAt}. Platform API: ${input.apiUrl}.`,
    '',
    'This file is the agent entry point for this workspace. Read it before changing code or claiming work.',
    '',
    '## Workspace layout',
    '',
    '- `code/` - project repositories checked out for this member.',
    '- `work/` - drafts, notes, and collaboration artifacts.',
    '- `outbox/` - deliverables prepared for handover or review.',
    '- `.agent/` - local binding, run state, and generated standards snapshots (ignored by Git).',
    '',
    '## Mandatory workflow',
    '',
    '1. Check the binding with `tsp project current` and use the platform as the source of truth.',
    '2. Claim or attach a task before implementation; read the task detail and Context Pack.',
    '3. Work in `code/` or the Run workspace; do not share uncommitted directories across runs.',
    '4. Submit artifacts and evidence explicitly. A Builder cannot verify or close its own task.',
    '5. If a standard below is unclear, read its snapshot or run `tsp docs show <document_code>`.',
    '',
    '## Project standards',
    '',
    'The following snapshots were generated from the platform standards folder and are authoritative at generation time.',
    'If the platform revision is newer, run `tsp workspace guidance --check`; if it reports stale, run `tsp workspace guidance`.',
    '',
  ];

  let index = 1;
  for (const entry of input.entries) {
    lines.push(
      `### ${index}. ${entry.title}`,
      '',
      `- document_code: \`${entry.document_code}\``,
      `- revision: \`${entry.revision}\``,
      `- snapshot: \`${entry.snapshot}\``,
      '',
      input.contents.get(entry.document_code) ?? '',
      '',
    );
    index += 1;
  }

  lines.push(
    '## Refresh',
    '',
    'After changing project standards in the platform, run from the workspace root:',
    '',
    '```powershell',
    'tsp workspace guidance',
    'tsp workspace guidance --check',
    '```',
  );
  return lines.join('\n');
}

function ensureCodeExclude(repoRoot: string): void {
  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  if (!existsSync(path.dirname(excludePath))) return;
  let current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const missing = ['AGENTS.md', 'CLAUDE.md'].filter((name) => (
    !new RegExp(`^${name}$`, 'm').test(current)
  ));
  if (missing.length === 0) return;
  if (current.length > 0 && !current.endsWith('\n')) current += '\n';
  writeFileSync(excludePath, `${current}${missing.join('\n')}\n`, 'utf8');
}

function copyGuidanceToCodeRepositories(workspaceRoot: string, agentsText: string): string[] {
  const codeRoot = path.join(workspaceRoot, 'code');
  if (!existsSync(codeRoot)) return [];
  const repos: string[] = [];
  for (const entry of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repoRoot = path.join(codeRoot, entry.name);
    if (!existsSync(path.join(repoRoot, '.git'))) continue;
    const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', 'AGENTS.md'], { stdio: 'ignore' });
    if (tracked.status !== 0) {
      const copy = [
        '# Team Synergy code checkout guidance',
        '',
        `This is a generated copy of the workspace guidance for agents starting in \`code/${entry.name}\`.`,
        'The canonical workspace file is `../../AGENTS.md`; the project standards are also snapshotted under `../../.agent/project-standards/`.',
        '',
        agentsText,
      ].join('\n');
      atomicWrite(path.join(repoRoot, 'AGENTS.md'), copy);
      atomicWrite(path.join(repoRoot, 'CLAUDE.md'), copy);
    }
    ensureCodeExclude(repoRoot);
    repos.push(path.relative(workspaceRoot, repoRoot).replaceAll('\\', '/'));
  }
  return repos;
}

export async function generateWorkspaceGuidance(options: GuidanceOptions = {}): Promise<GuidanceResult> {
  const resolved = resolveWorkspace(options.dir);
  const api = options.api ?? createApiClient({ baseUrl: resolved.apiUrl });
  const { folder, documents } = await fetchStandards(api, resolved.projectCode);

  const generatedAt = new Date().toISOString();
  const standardsDir = path.join(resolved.workspaceRoot, '.agent', 'project-standards');
  mkdirSync(standardsDir, { recursive: true });

  const entries: GuidanceDocument[] = [];
  const contents = new Map<string, string>();
  for (const document of documents) {
    const snapshot = `.agent/project-standards/${document.document_code}.md`;
    const body = [
      `<!-- Generated from Team Synergy project standards. document_code: ${document.document_code}; revision: ${document.current_revision}; generated_at: ${generatedAt} -->`,
      `# ${document.title}`,
      '',
      document.summary,
      '',
      document.content,
    ].join('\n');
    atomicWrite(path.join(standardsDir, `${document.document_code}.md`), body);
    entries.push({
      document_code: document.document_code,
      title: document.title,
      summary: document.summary,
      revision: document.current_revision,
      snapshot,
    });
    contents.set(document.document_code, document.content);
  }

  for (const name of readdirSync(standardsDir)) {
    if (name.endsWith('.md') && !entries.some((entry) => name === `${entry.document_code}.md`)) {
      unlinkSync(path.join(standardsDir, name));
    }
  }

  atomicWrite(
    path.join(standardsDir, 'manifest.json'),
    JSON.stringify({
      generated_at: generatedAt,
      project_code: resolved.projectCode,
      api_url: resolved.apiUrl,
      standards_folder_code: folder.folder_code,
      documents: entries,
    }, null, 2),
  );

  const agentsText = renderAgents({
    projectCode: resolved.projectCode,
    apiUrl: resolved.apiUrl,
    generatedAt,
    entries,
    contents,
  });
  atomicWrite(path.join(resolved.workspaceRoot, 'AGENTS.md'), agentsText);
  atomicWrite(path.join(resolved.workspaceRoot, 'CLAUDE.md'), agentsText);
  const codeRepositories = copyGuidanceToCodeRepositories(resolved.workspaceRoot, agentsText);

  return {
    project_code: resolved.projectCode,
    workspace_root: resolved.workspaceRoot,
    generated_at: generatedAt,
    documents: entries,
    code_repositories: codeRepositories,
  };
}

export async function checkWorkspaceGuidance(options: GuidanceOptions = {}): Promise<GuidanceCheckResult> {
  const resolved = resolveWorkspace(options.dir);
  const api = options.api ?? createApiClient({ baseUrl: resolved.apiUrl });
  const { documents } = await fetchStandards(api, resolved.projectCode);

  const manifestPath = path.join(resolved.workspaceRoot, '.agent', 'project-standards', 'manifest.json');
  interface GuidanceManifest {
    generated_at?: string;
    documents?: GuidanceDocument[];
  }
  let manifest: GuidanceManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as GuidanceManifest;
    } catch {
      manifest = null;
    }
  }
  const local = new Map((manifest?.documents ?? []).map((entry) => [entry.document_code, entry.revision]));
  const checks = documents.map((document) => {
    const localRevision = local.get(document.document_code) ?? null;
    return {
      document_code: document.document_code,
      title: document.title,
      local_revision: localRevision,
      remote_revision: document.current_revision,
      stale: localRevision !== document.current_revision,
    };
  });
  return {
    project_code: resolved.projectCode,
    up_to_date: checks.every((item) => !item.stale),
    manifest_generated_at: manifest?.generated_at ?? null,
    documents: checks,
  };
}
