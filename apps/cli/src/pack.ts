import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RequirementBaseline } from '@team-synergy/contracts';
import { renderRunSkillIndex, type RunSkillContext } from './skill-context.js';

/**
 * Context Pack 最小渲染（docs/13 必读卡）：
 * claim 成功后把「任务契约 + 验收标准 + 依赖状态 + 验证接缝 + 范围 + Run 身份」
 * 渲染为 workspace 内 project-state/brief.md —— 进入 Run 的 Agent 以它为起点读取上下文，
 * 缩小人与 Agent、Agent 与 Agent 之间的理解差异（docs/01 核心价值）。
 */

export interface RenderPackResult {
  briefPath: string;
  projectDocumentPath: string;
  requirementsIndexPath: string;
  requirementDocumentPath: string | null;
  designIndexPath: string;
  designPrototypePaths: string[];
  designNotesPaths: string[];
  handoffIndexPath: string;
  handoffDocumentPaths: string[];
  skillsIndexPath: string;
  acceptanceCount: number;
  dependencyCount: number;
}

/** 纯数据渲染：远程模式（HTTP）下从任务详情对象渲染（与 db 版同结构） */
export interface RemoteTaskShape {
  code?: string;
  task_code?: string;
  project_code?: string;
  feature_code?: string;
  feature_name?: string;
  module_code?: string | null;
  module_name?: string | null;
  milestone_code?: string | null;
  milestone_name?: string | null;
  phase_code?: string | null;
  phase_name?: string | null;
  /** 旧 API 兼容读取，新 Context Pack 不再输出 *_id。 */
  task_id?: string;
  project_id?: string;
  feature_id?: string;
  title: string;
  brief?: string | null;
  requirement_code?: string | null;
  requirement_title?: string | null;
  requirement_body?: string | null;
  requirement_baseline?: RequirementBaseline | null;
  requirement_acceptance_criteria?: Array<{ id: string; text: string }> | null;
  requirement_open_questions?: string[] | null;
  design_prototypes?: RemoteDesignPrototype[] | null;
  profile?: string;
  source?: string;
  status?: string;
  acceptance?: Array<{ id: string; text: string }>;
  validation_seams?: string[] | string | null;
  scope?: unknown;
  [k: string]: unknown;
}

export interface RemoteDesignPrototype {
  prototype_code: string;
  title: string;
  summary: string;
  status: string;
  current_revision: number;
  html_content: string;
  content_kind?: 'html' | 'image' | 'url' | 'file';
  external_url?: string | null;
  file_name?: string | null;
  file_mime_type?: string | null;
  file_size?: number | null;
  file_sha256?: string | null;
  download_path?: string | null;
  notes_markdown?: string;
  change_summary?: string;
  updated_at?: string;
}

export interface RemoteProjectDocument {
  project_code?: string;
  project_id?: string;
  title: string;
  content: string;
  revision: number;
  updated_by?: string | null;
  updated_at?: string | null;
}

export const PROJECT_HOME_ROLES = { overview: '项目说明', guide: '参与指引', standards: '项目规范' } as const;
export type ProjectHomeRole = keyof typeof PROJECT_HOME_ROLES;

export interface RemoteHomeDocument {
  document_code: string;
  title: string;
  summary: string;
  content: string;
  revision: number;
  updated_at: string;
}

export interface RemoteProjectHome {
  project_code: string;
  overview: RemoteHomeDocument | null;
  guide: RemoteHomeDocument | null;
  standards: RemoteHomeDocument[];
  /** Older home responses predate the dedicated standards folder. */
  standards_folder_code?: string;
}

function projectHomeDocuments(home: RemoteProjectHome, role: ProjectHomeRole): RemoteHomeDocument[] {
  const value = home[role];
  // Accept the former single-standard response when reading an older API or cached context.
  return Array.isArray(value) ? value : value ? [value] : [];
}

export interface RemoteRequirementDocumentSummary {
  code?: string;
  document_code?: string;
  project_code?: string;
  document_id?: string;
  project_id?: string;
  module_key: string;
  module_code?: string | null;
  module_name?: string | null;
  title: string;
  state: string;
  current_revision: number;
  summary: string;
  keywords?: string[];
  updated_at?: string;
}

export interface RemoteRequirementDocument extends RemoteRequirementDocumentSummary {
  content: string;
  change_summary?: string;
}

export interface RequirementDocumentContext {
  documents: RemoteRequirementDocumentSummary[];
  related: RemoteRequirementDocument | null;
}

export interface RemoteHandoffFolder {
  folder_code: string;
  parent_folder_code: string | null;
  name: string;
  status: string;
  sort_order?: number;
}

export interface RemoteHandoffDocumentSummary {
  document_code: string;
  source_kind?: 'project' | 'requirement' | 'architecture' | 'testing';
  folder_code: string | null;
  folder_name?: string | null;
  kind: string;
  title: string;
  summary: string;
  current_revision: number;
  status: string;
  updated_at?: string;
}

export interface RemoteHandoffDocument extends RemoteHandoffDocumentSummary {
  content: string;
}

export interface HandoffDocumentContext {
  folders: RemoteHandoffFolder[];
  documents: RemoteHandoffDocument[];
  home?: RemoteProjectHome;
}

export function renderContextPackFromTask(task: RemoteTaskShape, input: {
  workspaceRoot: string;
  runCode: string;
  principalCode: string;
  stateRoot?: string;
  executionMode?: 'worktree' | 'external_shared';
  skillContext?: RunSkillContext;
}, projectDocument: RemoteProjectDocument, requirementContext: RequirementDocumentContext = { documents: [], related: null }, handoffContext: HandoffDocumentContext = { folders: [], documents: [] }): RenderPackResult {
  handoffContext = { ...handoffContext, documents: handoffContext.documents.filter(document => document.source_kind !== 'testing') };
  const home = handoffContext.home;
  if (home) {
    // The home response fixes the role and revision together; reuse its body even if the library advanced afterwards.
    const documents = new Map(handoffContext.documents.map((document) => [document.document_code, document]));
    for (const role of Object.keys(PROJECT_HOME_ROLES) as ProjectHomeRole[]) {
      for (const document of projectHomeDocuments(home, role)) {
        documents.set(document.document_code, { folder_code: null, kind: 'doc', status: 'active', ...documents.get(document.document_code),
          ...document, current_revision: document.revision });
      }
    }
    handoffContext = { ...handoffContext, documents: [...documents.values()] };
    projectDocument = { project_code: home.project_code, title: home.overview?.title ?? '项目说明', content: home.overview?.content ?? '', revision: home.overview?.revision ?? 0 };
  }
  const acceptance = task.acceptance ?? [];
  const taskCode = task.code ?? task.task_code ?? task.task_id ?? '';
  const projectCode = projectDocument.project_code ?? projectDocument.project_id ?? task.project_code ?? task.project_id ?? '';
  const featureCode = task.feature_code ?? task.feature_id;
  const lines: string[] = [];
  lines.push(`# Brief: ${task.title}`);
  lines.push('');
  lines.push('> 本文件由 tsp 在 claim 时渲染（Context Pack 最小必读卡，docs/13）。');
  lines.push('> 环境是真相源：所有事实以平台数据库为准，本文件是渲染副本。');
  lines.push('');
  lines.push(`- Task Code: \`${taskCode}\``);
  lines.push(`- Project Code: \`${projectCode}\``);
  if (task.module_name || task.module_code) {
    lines.push(`- 功能模块：${task.module_name ?? '未命名'}${task.module_code ? `（\`${task.module_code}\`）` : ''}`);
  }
  if (featureCode) lines.push(`- Feature：${task.feature_name ?? '未命名'}（\`${featureCode}\`）`);
  if (task.phase_name || task.phase_code) {
    lines.push(`- 项目阶段：${task.phase_name ?? '未命名'}${task.phase_code ? `（\`${task.phase_code}\`）` : ''}`);
  }
  if (task.milestone_name || task.milestone_code) {
    lines.push(`- 目标里程碑：${task.milestone_name ?? '未命名'}${task.milestone_code ? `（\`${task.milestone_code}\`）` : ''}`);
  }
  lines.push(`- Profile: \`${task.profile ?? '-'}\` · Source: \`${task.source ?? '-'}\` · Status: \`${task.status ?? '-'}\``);
  lines.push(`- Run Code: \`${input.runCode}\` · User Code: \`${input.principalCode}\``);
  lines.push('');
  lines.push('## 执行简报');
  lines.push(task.brief?.trim() || '（当前任务没有维护执行简报；执行前应向任务 Owner 补齐目标、交付物、约束和验证方式。）');
  lines.push('');
  if (task.requirement_baseline) {
    const baseline = task.requirement_baseline;
    lines.push('## 固定需求基线', '', `- ${baseline.name} · V${baseline.version} · ${baseline.baseline_code}`,
      `- 范围：${baseline.scope}`, `- 内容哈希：${baseline.content_hash}`,
      '- 按以下冻结版本执行；最新需求变化不自动改变本任务目标。', '', '```json', JSON.stringify(baseline, null, 2), '```', '');
  }
  if (task.requirement_code || task.requirement_title || task.requirement_body) {
    lines.push('## 关联需求点');
    if (task.requirement_code) lines.push(`- Requirement Code: \`${task.requirement_code}\``);
    if (task.requirement_title) lines.push(`- 标题：${task.requirement_title}`);
    if (task.requirement_body) {
      lines.push('');
      lines.push(task.requirement_body.trim());
    }
    if (task.requirement_acceptance_criteria?.length) {
      lines.push('');
      lines.push('### 需求验收标准');
      for (const criterion of task.requirement_acceptance_criteria) {
        lines.push(`- ${criterion.id}: ${criterion.text}`);
      }
    }
    if (task.requirement_open_questions?.length) {
      lines.push('');
      lines.push('### 待澄清问题');
      for (const question of task.requirement_open_questions) lines.push(`- ${question}`);
    }
    lines.push('');
  }
  const designPrototypes = task.design_prototypes ?? [];
  lines.push('## 关联设计原型');
  if (designPrototypes.length === 0) {
    lines.push('- 当前需求尚未关联设计原型。');
  } else {
    lines.push('- 原型索引：`.agent/project-state/design/index.md`');
    for (const prototype of designPrototypes) {
      lines.push(`- ${prototype.title}（\`${prototype.prototype_code}\`） · ${prototype.status} · Revision ${prototype.current_revision}`);
      lines.push(`  - 材料：\`.agent/project-state/design/${designSourceFileName(prototype)}\``);
      lines.push(`  - 配套说明：\`.agent/project-state/design/${safeDocumentFileName(prototype.prototype_code)}.notes.md\``);
    }
  }
  lines.push('');
  if (home) lines.push(...projectHomeLinks(home, false));
  lines.push('## 项目文档库');
  lines.push('- 目录索引：`.agent/project-state/handoff/index.md`');
  if (handoffContext.documents.length === 0) {
    lines.push('- 当前尚无分类项目文档；兼容项目文档副本：`.agent/project-state/project-document.md`');
  } else {
    for (const document of handoffContext.documents) {
      lines.push(`- [${document.kind}] ${document.title}（\`${document.document_code}\`） · Revision ${document.current_revision}`);
      lines.push(`  - 副本：[${document.title}](${handoffDocumentRelativePath(document.document_code, home)})`);
    }
  }
  lines.push('- 架构图源及版本按需读取：`tsp architecture list --project <project_code>`、`tsp architecture show <document_code>`。');
  lines.push('- 测试用例与资料按需检索：`tsp test case search <关键词> --project <project_code>`、`tsp test asset search <关键词> --project <project_code>`；用 `show <code> --revision <n>` 读取固定版本，附件通过 `tsp test asset download <code> --revision <n> --output <path>` 导出。');
  lines.push('- 本 Run 的固定技能版本与本机入口：阅读本文件同目录的 `skills.md`，按需加载技能及资源。');
  lines.push('');
  if (!home && projectDocument.content.trim()) {
    lines.push('## 项目概览');
    lines.push(projectDocument.content.trim());
    lines.push('');
  }
  lines.push('## 需求文档索引');
  lines.push('- 全部模块索引：`.agent/project-state/requirements/index.md`');
  if (requirementContext.related) {
    const relatedCode = documentCode(requirementContext.related);
    lines.push(`- 当前任务相关文档编码：\`${relatedCode}\` · ${requirementContext.related.title}`);
    lines.push(`- 相关文档完整副本：\`.agent/project-state/requirements/${safeDocumentFileName(relatedCode)}.md\``);
    lines.push(`- 摘要：${requirementContext.related.summary}`);
  } else {
    lines.push('- 当前任务未关联具体需求文档；执行前按模块和关键词检查索引。');
  }
  lines.push('');
  lines.push('## 验收标准（全部满足才算交付）');
  if (acceptance.length === 0) {
    lines.push('（无）');
  } else {
    for (const a of acceptance) {
      lines.push(`- [ ] ${a.id}: ${a.text}`);
    }
  }
  const validationSeams = normalizeStringArray(task.validation_seams);
  if (validationSeams.length > 0) {
    lines.push('');
    lines.push('## 验证接缝（validation_seams，docs/21）');
    for (const seam of validationSeams) {
      lines.push(`- ${seam}`);
    }
  }
  if (task.scope) {
    lines.push('');
    lines.push('## 授权范围');
    lines.push('```json');
    lines.push(formatJson(task.scope));
    lines.push('```');
  }
  lines.push('');
  lines.push('## 完成定义');
  lines.push(input.executionMode === 'external_shared'
    ? '1. 代码改动在当前共享工作目录内完成；不要回退其他 Agent 的改动'
    : '1. 代码改动在 Run 工作区的 `repo/` 内完成并提交');
  lines.push('2. 自测证据覆盖全部验收标准（`tsp task submit`）');
  lines.push('3. 报告产物与证据 URI 记录在案');

  const packDir = input.stateRoot ?? path.join(input.workspaceRoot, '.agent', 'project-state');
  mkdirSync(packDir, { recursive: true });
  const briefPath = path.join(packDir, 'brief.md');
  const skillsIndexPath = path.join(packDir, 'skills.md');
  const projectDocumentPath = path.join(packDir, 'project-document.md');
  const requirementsDir = path.join(packDir, 'requirements');
  mkdirSync(requirementsDir, { recursive: true });
  const requirementsIndexPath = path.join(requirementsDir, 'index.md');
  const requirementDocumentPath = requirementContext.related
    ? path.join(requirementsDir, `${safeDocumentFileName(documentCode(requirementContext.related))}.md`)
    : null;
  const designDir = path.join(packDir, 'design');
  mkdirSync(designDir, { recursive: true });
  const designIndexPath = path.join(designDir, 'index.md');
  const designPrototypePaths = designPrototypes.map((prototype) => (
    path.join(designDir, designSourceFileName(prototype))
  ));
  const designNotesPaths = designPrototypes.map((prototype) => (
    path.join(designDir, `${safeDocumentFileName(prototype.prototype_code)}.notes.md`)
  ));
  const handoffDir = path.join(packDir, 'handoff');
  mkdirSync(handoffDir, { recursive: true });
  const handoffIndexPath = path.join(handoffDir, 'index.md');
  const handoffDocumentPaths = handoffContext.documents.map((document) => (
    path.join(packDir, handoffDocumentRelativePath(document.document_code, home))
  ));
  const projectDocumentFile = home?.overview
    ? renderHandoffDocument({ ...home.overview, folder_code: null, kind: 'doc', status: 'active', current_revision: home.overview.revision })
    : `# ${projectDocument.title}\n\n${projectDocument.content.trim() || (home ? '（项目首页尚未配置项目说明）' : '（项目 Owner 尚未维护正文）')}\n`;
  writeFileSync(projectDocumentPath, projectDocumentFile, 'utf8');
  writeFileSync(requirementsIndexPath, renderRequirementIndex(requirementContext.documents), 'utf8');
  if (requirementDocumentPath && requirementContext.related) {
    writeFileSync(requirementDocumentPath, renderRequirementDocument(requirementContext.related), 'utf8');
  }
  writeFileSync(designIndexPath, renderDesignIndex(designPrototypes), 'utf8');
  designPrototypes.forEach((prototype, index) => {
    if (prototype.content_kind === 'url' || prototype.content_kind === 'file') {
      rmSync(path.join(designDir, `${safeDocumentFileName(prototype.prototype_code)}.html`), { force: true });
      writeFileSync(designPrototypePaths[index]!, renderDesignSourceReference(prototype), 'utf8');
    } else {
      writeFileSync(designPrototypePaths[index]!, prototype.html_content, 'utf8');
    }
    writeFileSync(designNotesPaths[index]!, renderDesignNotes(prototype), 'utf8');
  });
  writeFileSync(handoffIndexPath, renderHandoffIndex(handoffContext), 'utf8');
  handoffContext.documents.forEach((document, index) => {
    if (home?.overview?.document_code === document.document_code) return;
    writeFileSync(handoffDocumentPaths[index]!, renderHandoffDocument(document), 'utf8');
  });
  writeFileSync(briefPath, lines.join('\n') + '\n', 'utf8');
  writeFileSync(skillsIndexPath, renderRunSkillIndex(input.skillContext), 'utf8');

  return {
    briefPath,
    projectDocumentPath,
    requirementsIndexPath,
    requirementDocumentPath,
    designIndexPath,
    designPrototypePaths,
    designNotesPaths,
    handoffIndexPath,
    handoffDocumentPaths,
    skillsIndexPath,
    acceptanceCount: acceptance.length,
    dependencyCount: 0,
  };
}

function handoffFolderPath(folderCode: string | null, folders: RemoteHandoffFolder[]): string {
  if (!folderCode) return '根目录';
  const byCode = new Map(folders.map((folder) => [folder.folder_code, folder]));
  const names: string[] = [];
  const visited = new Set<string>();
  let cursor = byCode.get(folderCode);
  while (cursor && !visited.has(cursor.folder_code)) {
    visited.add(cursor.folder_code);
    names.unshift(cursor.name);
    cursor = cursor.parent_folder_code ? byCode.get(cursor.parent_folder_code) : undefined;
  }
  return names.join(' / ') || '根目录';
}

function handoffDocumentRelativePath(documentCode: string, home?: RemoteProjectHome): string {
  return home?.overview?.document_code === documentCode ? 'project-document.md' : `handoff/${safeDocumentFileName(documentCode)}.md`;
}

function projectHomeLinks(home: RemoteProjectHome, inHandoff: boolean): string[] {
  const lines = ['## 项目必读资料', '', '执行前阅读以下已绑定资料；文档角色与版本以本次上下文副本为准。', ''];
  for (const role of Object.keys(PROJECT_HOME_ROLES) as ProjectHomeRole[]) {
    const documents = projectHomeDocuments(home, role);
    if (documents.length === 0) {
      lines.push(`- ${PROJECT_HOME_ROLES[role]}：${role === 'standards' ? '暂无规范文档' : '尚未配置'}。`);
      continue;
    }
    for (const document of documents) {
      const target = handoffDocumentRelativePath(document.document_code, home);
      lines.push(`- ${PROJECT_HOME_ROLES[role]}：[${document.title}](${inHandoff ? `../${target}` : target}) · Code: \`${document.document_code}\` · Revision ${document.revision}`);
    }
  }
  lines.push('');
  return lines;
}

function renderHandoffIndex(context: HandoffDocumentContext): string {
  const lines = [
    '# 项目文档库',
    '',
    '> 接口、联调、部署、数据、发布和运维等跨角色事实；需要全文时读取编码对应的 Markdown 副本。',
    '',
    '架构图源及历史按需读取：`tsp architecture list --project <project_code>`、`tsp architecture show <document_code>`。',
    '测试资料不会自动复制到每个任务包。使用 `tsp test asset list --project <project_code>`、`tsp test asset search <关键词> --project <project_code>` 和 `tsp test asset show <code> --revision <n>` 按需读取；用例对应 `tsp test case list/search/show`。',
    '',
  ];
  if (context.home) lines.push(...projectHomeLinks(context.home, true));
  if (context.documents.length === 0) {
    lines.push('（项目尚未维护项目文档）', '');
    return lines.join('\n');
  }
  for (const document of context.documents) {
    lines.push(`## ${document.title}`);
    lines.push(`- Code: \`${document.document_code}\` · Type: \`${document.kind}\` · Revision: \`${document.current_revision}\``);
    lines.push(`- 目录：${handoffFolderPath(document.folder_code, context.folders)}`);
    lines.push(`- 文件：[${document.title}](../${handoffDocumentRelativePath(document.document_code, context.home)})`);
    if (document.summary) lines.push(`- 摘要：${document.summary}`);
    lines.push('');
  }
  lines.push('按需检索：`tsp docs search <关键词> --project <project_code>`', '');
  return lines.join('\n');
}

function renderHandoffDocument(document: RemoteHandoffDocument): string {
  return [
    `# ${document.title}`,
    '',
    `> Document Code: ${document.document_code} · Type: ${document.kind} · Revision: ${document.current_revision}`,
    `> 摘要：${document.summary}`,
    '',
    document.content.trim(),
    '',
  ].join('\n');
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function safeDocumentFileName(documentId: string): string {
  return documentId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function documentCode(document: RemoteRequirementDocumentSummary): string {
  return document.code ?? document.document_code ?? document.document_id ?? '';
}

function renderRequirementIndex(documents: RemoteRequirementDocumentSummary[]): string {
  const lines = [
    '# 项目需求文档索引',
    '',
    '> 先根据模块、摘要和关键词选择文档；需要完整上下文时再读取正文。',
    '',
  ];
  if (documents.length === 0) {
    lines.push('（项目尚未维护模块化需求文档）', '');
    return lines.join('\n');
  }
  for (const document of documents) {
    lines.push(`## ${document.module_name ?? document.module_key} · ${document.title}`);
    if (document.module_code) lines.push(`- Module Code: \`${document.module_code}\``);
    lines.push(`- Code: \`${documentCode(document)}\` · State: \`${document.state}\` · Revision: \`${document.current_revision}\``);
    lines.push(`- 摘要：${document.summary}`);
    if (document.keywords?.length) lines.push(`- 关键词：${document.keywords.join('、')}`);
    lines.push('');
  }
  lines.push('按需查询：`tsp requirement-doc search <关键词> --project <project_code>`', '');
  return lines.join('\n');
}

function renderRequirementDocument(document: RemoteRequirementDocument): string {
  return [
    `# ${document.title}`,
    '',
    `> Document Code: ${documentCode(document)} · Module: ${document.module_name ?? document.module_key}${document.module_code ? `（${document.module_code}）` : ''} · State: ${document.state} · Revision: ${document.current_revision}`,
    `> 摘要：${document.summary}`,
    '',
    document.content.trim(),
    '',
  ].join('\n');
}

function designSourceFileName(prototype: RemoteDesignPrototype): string {
  return `${safeDocumentFileName(prototype.prototype_code)}.${prototype.content_kind === 'url' || prototype.content_kind === 'file' ? 'source.md' : 'html'}`;
}

export function renderDesignSourceReference(prototype: Pick<RemoteDesignPrototype, 'prototype_code' | 'current_revision' | 'content_kind' | 'external_url' | 'file_name' | 'file_mime_type' | 'file_size' | 'file_sha256' | 'download_path'>): string {
  const lines = ['# 设计材料来源', '', '```json', JSON.stringify({
    prototype_code: prototype.prototype_code,
    revision: prototype.current_revision,
    content_kind: prototype.content_kind,
    external_url: prototype.external_url ?? null,
    file_name: prototype.file_name ?? null,
    file_mime_type: prototype.file_mime_type ?? null,
    file_size: prototype.file_size ?? null,
    file_sha256: prototype.file_sha256 ?? null,
    download_path: prototype.download_path ?? null,
  }, null, 2), '```', ''];
  if (prototype.content_kind === 'url') lines.push('该链接指向外部页面；平台固定的是链接记录，远端页面内容可能变化。按需打开，未自动抓取。', '');
  if (prototype.content_kind === 'file') lines.push('原始附件按需下载；未自动下载或执行。请使用当前成员的登录身份：', '', '```text', `tsp design download ${prototype.prototype_code} --revision ${prototype.current_revision} --out <local-path>`, '```', '');
  return lines.join('\n');
}

function renderDesignIndex(prototypes: RemoteDesignPrototype[]): string {
  const lines = [
    '# 关联设计原型',
    '',
    '> 这些材料是领取任务时从平台当前 Revision 导出的只读上下文副本；外部链接和附件保留来源引用，平台仍是真相源。',
    '',
  ];
  if (prototypes.length === 0) {
    lines.push('（当前需求尚未关联设计原型）', '');
    return lines.join('\n');
  }
  for (const prototype of prototypes) {
    lines.push(`## ${prototype.title}`);
    lines.push(`- Code: \`${prototype.prototype_code}\` · State: \`${prototype.status}\` · Revision: \`${prototype.current_revision}\``);
    lines.push(`- 材料（${prototype.content_kind ?? 'html'}）: \`${designSourceFileName(prototype)}\``);
    lines.push(`- 配套说明: \`${safeDocumentFileName(prototype.prototype_code)}.notes.md\``);
    if (prototype.summary) lines.push(`- 摘要：${prototype.summary}`);
    if (prototype.change_summary) lines.push(`- 当前版本：${prototype.change_summary}`);
    lines.push('');
  }
  lines.push('按需查看线上详情：`tsp design show <prototype_code>`', '');
  return lines.join('\n');
}

function renderDesignNotes(prototype: RemoteDesignPrototype): string {
  if (prototype.notes_markdown?.trim()) return `${prototype.notes_markdown.trim()}\n`;
  return [
    `# ${prototype.title} · 配套设计说明`,
    '',
    '（当前 Revision 尚未维护业务、数据、代码逻辑或注意事项。）',
    '',
  ].join('\n');
}
