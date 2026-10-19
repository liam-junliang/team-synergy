import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Project Core 存储 Schema。
 * 设计依据：docs/02 领域模型、docs/09 图存储、docs/15 成员模型、docs/19 Defect。
 * 软引用策略：跨聚合关系不在库层声明 FK，由 application 用例保证业务完整性。
 */

const PUBLIC_CODE_PATTERN_SQL = '^[0-9A-HJKMNP-TV-Z]{20}$';

function identityId() {
  return bigint('id', { mode: 'bigint' }).primaryKey().generatedByDefaultAsIdentity();
}

function publicCode() {
  return varchar('code', { length: 20 }).notNull().default(sql`acp_generate_public_code()`);
}

function codeConstraints(tableName: string, table: { code: unknown }) {
  return [
    uniqueIndex(`uq_${tableName}_code`).on(table.code as never),
    check(`ck_${tableName}_code`, sql`${table.code as never} ~ '${sql.raw(PUBLIC_CODE_PATTERN_SQL)}'`),
  ];
}

/** Deployment-facing URLs, separate from team/project business data. */
export const systemSettings = pgTable(
  'system_settings',
  {
    id: integer('id').primaryKey().default(1),
    public_web_url: text('public_web_url'),
    public_api_url: text('public_api_url'),
    revision: integer('revision').notNull().default(0),
    updated_at: text('updated_at'),
    updated_by: bigint('updated_by', { mode: 'bigint' }),
  },
  (t) => [check('ck_system_settings_singleton', sql`${t.id} = 1`), check('ck_system_settings_revision', sql`${t.revision} >= 0`)],
);

export const teams = pgTable(
  'teams',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    name: text('name').notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }),
    owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }),
    created_at: text('created_at').notNull(),
  },
  (t) => [...codeConstraints('teams', t), uniqueIndex('uq_teams_legacy_code').on(t.legacy_code)],
);

export const projects = pgTable(
  'projects',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    team_id: bigint('team_id', { mode: 'bigint' }).notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }),
    owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }),
    member_policy: text('member_policy', { enum: ['private', 'team_read', 'team_write'] }).notNull().default('private'),
    name: text('name').notNull(),
    description: text('description'),
    overview_document_id: bigint('overview_document_id', { mode: 'bigint' }),
    guide_document_id: bigint('guide_document_id', { mode: 'bigint' }),
    standards_document_id: bigint('standards_document_id', { mode: 'bigint' }),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    current_snapshot: integer('current_snapshot').notNull().default(0),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('projects', t),
    uniqueIndex('uq_projects_legacy_code').on(t.legacy_code),
    index('idx_projects_team').on(t.team_id),
    check('ck_projects_member_policy', sql`${t.member_policy} in ('private', 'team_read', 'team_write')`),
  ],
);

/** 云端项目登记的逻辑代码仓库；本地用户可按需检出其中任意子集。 */
export const projectRepositories = pgTable(
  'project_repositories',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    purpose: text('purpose'),
    remote_url: text('remote_url').notNull(),
    default_branch: text('default_branch'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_repositories', t),
    uniqueIndex('uq_project_repositories_project_remote').on(t.project_id, t.remote_url),
    index('idx_project_repositories_project').on(t.project_id),
    index('idx_project_repositories_status').on(t.status),
  ],
);

/** 某个用户在某台设备绑定的持久项目工作空间；云端不保存本机绝对路径。 */
export const projectWorkspaces = pgTable(
  'project_workspaces',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    last_seen_at: text('last_seen_at').notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_workspaces', t),
    index('idx_project_workspaces_project').on(t.project_id),
    index('idx_project_workspaces_principal').on(t.principal_id),
  ],
);

/** 项目交接文档文件夹：允许嵌套组织接口、部署、数据和发布等协作文档。 */
export const projectDocumentFolders = pgTable(
  'project_document_folders',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    parent_id: bigint('parent_id', { mode: 'bigint' }),
    name: text('name').notNull(),
    system_role: text('system_role', { enum: ['standards', 'requirements', 'architecture', 'testing'] }),
    sort_order: integer('sort_order').notNull().default(0),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    created_by: bigint('created_by', { mode: 'bigint' }),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_document_folders', t),
    uniqueIndex('uq_project_document_folders_system_role').on(t.project_id, t.system_role),
    check('ck_project_document_folders_system_role', sql`${t.system_role} is null or ${t.system_role} in ('standards', 'requirements', 'architecture', 'testing')`),
    check('ck_project_document_folders_system_shape', sql`${t.system_role} is null or (${t.parent_id} is null and ${t.status} = 'active' and ((${t.system_role} = 'standards' and ${t.name} = '项目规范') or (${t.system_role} = 'requirements' and ${t.name} = '需求文档') or (${t.system_role} = 'architecture' and ${t.name} = '架构设计') or (${t.system_role} = 'testing' and ${t.name} = '测试资料')))`),
    check('ck_project_document_folders_creator', sql`${t.created_by} is not null or ${t.system_role} is not null`),
    index('idx_project_document_folders_project').on(t.project_id, t.status, t.sort_order),
    index('idx_project_document_folders_parent').on(t.parent_id, t.sort_order),
  ],
);

/** 项目交接文档主表：一个项目可按文件夹维护多份文档，content/revision 缓存当前版本。 */
export const projectDocuments = pgTable(
  'project_documents',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    folder_id: bigint('folder_id', { mode: 'bigint' }),
    kind: text('kind', { enum: ['doc', 'api', 'diagram', 'general', 'integration', 'deployment', 'data', 'operations', 'release'] }).notNull().default('doc'),
    title: text('title').notNull(),
    summary: text('summary'),
    content: text('content').notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_by: bigint('updated_by', { mode: 'bigint' }).notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_documents', t),
    index('idx_project_documents_project').on(t.project_id, t.status, t.title),
    index('idx_project_documents_folder').on(t.folder_id, t.status, t.title),
    index('idx_project_documents_kind').on(t.project_id, t.kind),
    check('ck_project_documents_kind', sql`${t.kind} in ('doc', 'api', 'diagram', 'general', 'integration', 'deployment', 'data', 'operations', 'release')`),
  ],
);

/** 项目交接文档不可变修订，用于任务交付与验收固定引用。 */
export const projectDocumentRevisions = pgTable(
  'project_document_revisions',
  {
    id: identityId(),
    code: publicCode(),
    document_id: bigint('document_id', { mode: 'bigint' }).notNull(),
    revision: integer('revision').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    content: text('content').notNull(),
    change_summary: text('change_summary').notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_document_revisions', t),
    uniqueIndex('uq_project_document_revisions_document_revision').on(t.document_id, t.revision),
    index('idx_project_document_revisions_document').on(t.document_id, t.revision),
  ],
);

export const projectModules = pgTable(
  'project_modules',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    sort_order: integer('sort_order').notNull().default(0),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_modules', t),
    index('idx_project_modules_project').on(t.project_id),
    index('idx_project_modules_project_sort').on(t.project_id, t.sort_order),
    index('idx_project_modules_project_status').on(t.project_id, t.status),
  ],
);

export const projectPhases = pgTable(
  'project_phases',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    goal: text('goal'),
    sort_order: integer('sort_order').notNull().default(0),
    start_date: text('start_date'),
    end_date: text('end_date'),
    status: text('status', { enum: ['planned', 'active', 'completed', 'archived'] }).notNull().default('planned'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_phases', t),
    index('idx_project_phases_project').on(t.project_id),
    index('idx_project_phases_project_sort').on(t.project_id, t.sort_order),
    index('idx_project_phases_project_status').on(t.project_id, t.status),
  ],
);

export const projectMilestones = pgTable(
  'project_milestones',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    phase_id: bigint('phase_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    goal: text('goal'),
    start_date: text('start_date'),
    target_date: text('target_date'),
    sort_order: integer('sort_order').notNull().default(0),
    status: text('status', { enum: ['planned', 'active', 'at_risk', 'completed', 'cancelled'] }).notNull().default('planned'),
    owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('project_milestones', t),
    index('idx_project_milestones_project').on(t.project_id),
    index('idx_project_milestones_phase').on(t.phase_id),
    index('idx_project_milestones_project_sort').on(t.project_id, t.sort_order),
    index('idx_project_milestones_project_status').on(t.project_id, t.status),
  ],
);

/** 项目可维护多份模块化需求文档；文档头只保存当前版本指针。 */
export const requirementDocuments = pgTable(
  'requirement_documents',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    module_id: bigint('module_id', { mode: 'bigint' }),
    module_key: text('module_key').notNull(),
    title: text('title').notNull(),
    current_revision: integer('current_revision').notNull().default(1),
    state: text('state', { enum: ['active', 'archived'] }).notNull().default('active'),
    owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('requirement_documents', t),
    uniqueIndex('uq_requirement_documents_legacy_code').on(t.legacy_code),
    index('idx_requirement_documents_project').on(t.project_id),
    index('idx_requirement_documents_module_id').on(t.module_id),
    index('idx_requirement_documents_module').on(t.project_id, t.module_key),
    index('idx_requirement_documents_state').on(t.project_id, t.state),
  ],
);

/** 需求文档正文不可变修订；摘要与关键词随正文一同版本化，供 Agent 快速检索。 */
export const requirementDocumentRevisions = pgTable(
  'requirement_document_revisions',
  {
    id: identityId(),
    code: publicCode(),
    document_id: bigint('document_id', { mode: 'bigint' }).notNull(),
    revision: integer('revision').notNull(),
    summary: text('summary').notNull(),
    content: text('content').notNull(),
    keywords: text('keywords').notNull().default('[]'),
    change_summary: text('change_summary').notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('requirement_document_revisions', t),
    uniqueIndex('uq_requirement_document_revisions_document_revision').on(t.document_id, t.revision),
    index('idx_requirement_document_revisions_document').on(t.document_id),
  ],
);

/** 尚未进入正式讨论的原始想法；保持轻量，只承担汇聚、检索与归档。 */
export const requirementIdeas = pgTable(
  'requirement_ideas',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    source: text('source'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('requirement_ideas', t),
    index('idx_requirement_ideas_project_status').on(t.project_id, t.status),
    index('idx_requirement_ideas_project_updated').on(t.project_id, t.updated_at),
  ],
);

/** 需求议题是讨论与决策留痕空间，不等同于 Feature。 */
export const requirementTopics = pgTable(
  'requirement_topics',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    problem_statement: text('problem_statement').notNull().default(''),
    goal: text('goal').notNull().default(''),
    status: text('status', { enum: ['open', 'decided', 'reopened', 'archived'] }).notNull().default('open'),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('requirement_topics', t),
    index('idx_requirement_topics_project_status').on(t.project_id, t.status),
    index('idx_requirement_topics_project_updated').on(t.project_id, t.updated_at),
  ],
);

/** 一个想法可被多个议题引用，一个议题也可汇聚多个想法。 */
export const requirementTopicIdeas = pgTable(
  'requirement_topic_ideas',
  {
    topic_id: bigint('topic_id', { mode: 'bigint' }).notNull(),
    idea_id: bigint('idea_id', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.topic_id, t.idea_id] }),
    index('idx_requirement_topic_ideas_idea').on(t.idea_id),
  ],
);

/** 议题时间线统一承载讨论、备选方案、方案调整和可追溯决策。 */
export const requirementTopicEntries = pgTable(
  'requirement_topic_entries',
  {
    id: identityId(),
    code: publicCode(),
    topic_id: bigint('topic_id', { mode: 'bigint' }).notNull(),
    entry_type: text('entry_type', { enum: ['comment', 'alternative', 'feedback', 'decision'] }).notNull(),
    content: text('content').notNull(),
    rationale: text('rationale'),
    supersedes_entry_id: bigint('supersedes_entry_id', { mode: 'bigint' }),
    source_entity_type: text('source_entity_type'),
    source_entity_code: varchar('source_entity_code', { length: 20 }),
    author_principal_id: bigint('author_principal_id', { mode: 'bigint' }).notNull(),
    withdrawn_at: text('withdrawn_at'),
    withdrawn_by: bigint('withdrawn_by', { mode: 'bigint' }),
    withdrawal_reason: text('withdrawal_reason'),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('requirement_topic_entries', t),
    check('ck_requirement_topic_entries_withdrawn', sql`(${t.withdrawn_at} IS NULL AND ${t.withdrawn_by} IS NULL) OR (${t.withdrawn_at} IS NOT NULL AND ${t.withdrawn_by} IS NOT NULL)`),
    index('idx_requirement_topic_entries_topic').on(t.topic_id, t.created_at),
    index('idx_requirement_topic_entries_source').on(t.source_entity_type, t.source_entity_code),
  ],
);

/** 议题记录图片独立存储，避免把附件协议混入正文；后续可无损迁移到对象存储 URL。 */
export const requirementTopicEntryImages = pgTable(
  'requirement_topic_entry_images',
  {
    id: identityId(),
    code: publicCode(),
    entry_id: bigint('entry_id', { mode: 'bigint' }).notNull(),
    file_name: text('file_name').notNull(),
    mime_type: text('mime_type', { enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }).notNull(),
    byte_size: integer('byte_size').notNull(),
    data_url: text('data_url').notNull(),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('requirement_topic_entry_images', t),
    check('ck_requirement_topic_entry_images_mime', sql`${t.mime_type} IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`),
    check('ck_requirement_topic_entry_images_size', sql`${t.byte_size} > 0 AND ${t.byte_size} <= 2097152`),
    index('idx_requirement_topic_entry_images_entry').on(t.entry_id, t.sort_order),
  ],
);

/** 议题和需求文档是多对多关系：决策可沉淀为多份文档，文档也可综合多个议题。 */
export const requirementTopicDocuments = pgTable(
  'requirement_topic_documents',
  {
    topic_id: bigint('topic_id', { mode: 'bigint' }).notNull(),
    document_id: bigint('document_id', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.topic_id, t.document_id] }),
    index('idx_requirement_topic_documents_document').on(t.document_id),
  ],
);

/** 可选评审固定绑定不可变的需求文档 Revision，不作为提炼需求项或拆任务的硬门禁。 */
export const requirementDocumentReviews = pgTable(
  'requirement_document_reviews',
  {
    id: identityId(),
    code: publicCode(),
    document_revision_id: bigint('document_revision_id', { mode: 'bigint' }).notNull(),
    status: text('status', { enum: ['open', 'closed', 'cancelled'] }).notNull().default('open'),
    conclusion: text('conclusion', { enum: ['passed', 'changes_requested', 'no_consensus'] }),
    requested_by: bigint('requested_by', { mode: 'bigint' }).notNull(),
    opened_at: text('opened_at').notNull(),
    closed_by: bigint('closed_by', { mode: 'bigint' }),
    closed_at: text('closed_at'),
  },
  (t) => [
    ...codeConstraints('requirement_document_reviews', t),
    uniqueIndex('uq_requirement_document_reviews_revision').on(t.document_revision_id),
    index('idx_requirement_document_reviews_status').on(t.status),
  ],
);

/** 项目成员对评审的独立意见；同一成员在一次评审中仅保留一票，可在关闭前修改。 */
export const requirementDocumentReviewVotes = pgTable(
  'requirement_document_review_votes',
  {
    review_id: bigint('review_id', { mode: 'bigint' }).notNull(),
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    vote: text('vote', { enum: ['support', 'changes_requested', 'abstain'] }).notNull(),
    comment: text('comment').notNull().default(''),
    responded_at: text('responded_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.review_id, t.principal_id] }),
    index('idx_requirement_document_review_votes_principal').on(t.principal_id),
  ],
);

/** 需求梳理后的可运行 HTML 原型；原型头保存当前版本与协作状态。 */
export const designPrototypes = pgTable(
  'design_prototypes',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    status: text('status', { enum: ['draft', 'ready', 'archived'] }).notNull().default('draft'),
    current_revision: integer('current_revision').notNull().default(1),
    owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('design_prototypes', t),
    index('idx_design_prototypes_project').on(t.project_id),
    index('idx_design_prototypes_project_status').on(t.project_id, t.status),
    index('idx_design_prototypes_project_updated').on(t.project_id, t.updated_at),
  ],
);

/** 视觉原型及其配套设计说明的不可变修订；页面始终通过原型头读取当前版本。 */
export const designPrototypeRevisions = pgTable(
  'design_prototype_revisions',
  {
    id: identityId(),
    code: publicCode(),
    prototype_id: bigint('prototype_id', { mode: 'bigint' }).notNull(),
    revision: integer('revision').notNull(),
    html_content: text('html_content').notNull(),
    content_kind: text('content_kind', { enum: ['html', 'image', 'url', 'file'] }).notNull().default('html'),
    external_url: text('external_url'),
    file_name: text('file_name'),
    file_mime_type: text('file_mime_type'),
    file_size: integer('file_size'),
    file_sha256: text('file_sha256'),
    file_content_base64: text('file_content_base64'),
    notes_markdown: text('notes_markdown').notNull().default(''),
    change_summary: text('change_summary').notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('design_prototype_revisions', t),
    uniqueIndex('uq_design_prototype_revisions_prototype_revision').on(t.prototype_id, t.revision),
    index('idx_design_prototype_revisions_prototype').on(t.prototype_id, t.revision),
  ],
);

/** 一个原型可覆盖多个需求点，一个需求点也可被多个原型探索。 */
export const designPrototypeRequirements = pgTable(
  'design_prototype_requirements',
  {
    prototype_id: bigint('prototype_id', { mode: 'bigint' }).notNull(),
    requirement_id: bigint('requirement_id', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.prototype_id, t.requirement_id] }),
    index('idx_design_prototype_requirements_requirement').on(t.requirement_id),
  ],
);

/** 项目架构资料头；图源和说明保存在不可变修订中。 */
export const architectureDocuments = pgTable(
  'architecture_documents',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    content_kind: text('content_kind', { enum: ['mermaid', 'drawio', 'image'] }).notNull(),
    current_revision: integer('current_revision').notNull().default(1),
    owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    ...codeConstraints('architecture_documents', t),
    index('idx_architecture_documents_project_updated').on(t.project_id, t.updated_at),
    check('ck_architecture_documents_kind', sql`${t.content_kind} in ('mermaid', 'drawio', 'image')`),
    check('ck_architecture_documents_revision', sql`${t.current_revision} > 0`),
  ],
);

export const architectureDocumentRevisions = pgTable(
  'architecture_document_revisions',
  {
    id: identityId(),
    code: publicCode(),
    document_id: bigint('document_id', { mode: 'bigint' }).notNull(),
    revision: integer('revision').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    content_kind: text('content_kind', { enum: ['mermaid', 'drawio', 'image'] }).notNull(),
    source_content: text('source_content').notNull(),
    notes_markdown: text('notes_markdown').notNull().default(''),
    preview_svg: text('preview_svg'),
    change_summary: text('change_summary').notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('architecture_document_revisions', t),
    uniqueIndex('uq_architecture_document_revisions_document_revision').on(t.document_id, t.revision),
    check('ck_architecture_document_revisions_revision', sql`${t.revision} > 0`),
    check('ck_architecture_document_revisions_kind', sql`${t.content_kind} in ('mermaid', 'drawio', 'image')`),
    check('ck_architecture_document_revisions_source_size', sql`octet_length(${t.source_content}) between 1 and 6291456`),
    check('ck_architecture_document_revisions_preview_size', sql`${t.preview_svg} is null or octet_length(${t.preview_svg}) <= 2097152`),
  ],
);

/** 用户账号本体（docs/23）：全局唯一身份；members.principal_id = users.id */
export const users = pgTable(
  'users',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    account: text('account').notNull(),
    display_name: text('display_name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
    pending_deletion: boolean('pending_deletion').notNull().default(false),
    deleted_at: text('deleted_at'),
    is_system_admin: boolean('is_system_admin').notNull().default(false),
    password_hash: text('password_hash'),
    must_change_password: boolean('must_change_password').notNull().default(false),
    password_expires_at: text('password_expires_at'),
    bind_token_hash: text('bind_token_hash'),
    bind_token_expires_at: text('bind_token_expires_at'),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('users', t),
    uniqueIndex('uq_users_legacy_code').on(t.legacy_code),
    index('idx_users_status').on(t.status),
    uniqueIndex('uq_users_account').on(t.account),
  ],
);

/** 团队成员关系：团队是项目的上级协作边界，独立于项目内角色。 */
export const teamMembers = pgTable(
  'team_members',
  {
    team_id: bigint('team_id', { mode: 'bigint' }).notNull(),
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    display_name: text('display_name').notNull(),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.team_id, t.principal_id] }),
    index('idx_team_members_principal').on(t.principal_id),
  ],
);

/** 项目成员关系（历史表名保留，避免破坏现有任务闭环）。 */
export const members = pgTable(
  'members',
  {
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull(),
    display_name: text('display_name').notNull(),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.principal_id, t.project_id] }),
    index('idx_members_project').on(t.project_id),
  ],
);

export const ownershipTransfers = pgTable('ownership_transfers', {
  id: identityId(),
  code: publicCode(),
  scope: text('scope', { enum: ['team', 'project'] }).notNull(),
  scope_id: bigint('scope_id', { mode: 'bigint' }).notNull(),
  from_principal_id: bigint('from_principal_id', { mode: 'bigint' }).notNull(),
  to_principal_id: bigint('to_principal_id', { mode: 'bigint' }).notNull(),
  initiated_by: bigint('initiated_by', { mode: 'bigint' }).notNull(),
  is_recovery: boolean('is_recovery').notNull().default(false),
  reason: text('reason'),
  status: text('status', { enum: ['pending', 'accepted', 'cancelled'] }).notNull().default('pending'),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at').notNull(),
  completed_at: text('completed_at'),
}, (t) => [
  ...codeConstraints('ownership_transfers', t),
  uniqueIndex('uq_ownership_transfers_pending').on(t.scope, t.scope_id).where(sql`${t.status} = 'pending'`),
  index('idx_ownership_transfers_recipient').on(t.to_principal_id, t.status),
]);

/** Personal ordering never creates explicit permission grants. */
export const projectOrders = pgTable('project_orders', {
  project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
  principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
  sort_order: integer('sort_order').notNull(),
}, (t) => [primaryKey({ columns: [t.project_id, t.principal_id] })]);

export const devices = pgTable(
  'devices',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    device_name: text('device_name'),
    credential_hash: text('credential_hash').notNull(),
    installation_id: text('installation_id'),
    installation_secret_hash: text('installation_secret_hash'),
    client_type: text('client_type', { enum: ['legacy', 'web', 'cli'] }).notNull().default('legacy'),
    platform: text('platform'),
    last_login_at: text('last_login_at'),
    revoked_at: text('revoked_at'),
    legacy_session_initialized: boolean('legacy_session_initialized').notNull().default(false),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('devices', t),
    uniqueIndex('uq_devices_legacy_code').on(t.legacy_code),
    index('idx_devices_principal').on(t.principal_id),
    uniqueIndex('uq_devices_installation').on(t.principal_id, t.client_type, t.installation_id),
  ],
);

/** Bearer credentials belong to login sessions, never to the stable installation identity. */
export const deviceSessions = pgTable('device_sessions', {
  id: identityId(), code: publicCode(),
  device_id: bigint('device_id', { mode: 'bigint' }).notNull(),
  token_hash: text('token_hash').notNull(),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at'), revoked_at: text('revoked_at'),
}, (t) => [...codeConstraints('device_sessions', t), uniqueIndex('uq_device_sessions_token').on(t.token_hash), index('idx_device_sessions_device').on(t.device_id)]);

export const deviceAuthorizationRequests = pgTable('device_authorization_requests', {
  id: identityId(),
  device_code_hash: text('device_code_hash').notNull(),
  user_code_hash: text('user_code_hash').notNull(),
  device_name: text('device_name').notNull(),
  installation_id: text('installation_id').notNull(),
  installation_secret_hash: text('installation_secret_hash').notNull(),
  client_type: text('client_type', { enum: ['web', 'cli'] }).notNull(),
  platform: text('platform').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied', 'consumed'] }).notNull().default('pending'),
  principal_id: bigint('principal_id', { mode: 'bigint' }),
  created_at: text('created_at').notNull(), expires_at: text('expires_at').notNull(),
  last_polled_at: text('last_polled_at'), interval_seconds: integer('interval_seconds').notNull().default(5),
}, (t) => [uniqueIndex('uq_device_authorization_secret').on(t.device_code_hash), uniqueIndex('uq_device_authorization_user_code').on(t.user_code_hash), index('idx_device_authorization_expiry').on(t.expires_at)]);

export const features = pgTable(
  'features',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    module_id: bigint('module_id', { mode: 'bigint' }),
    milestone_id: bigint('milestone_id', { mode: 'bigint' }),
    title: text('title').notNull(),
    goal: text('goal'),
    sort_order: integer('sort_order').notNull().default(0),
    start_date: text('start_date'),
    end_date: text('end_date'),
    status: text('status', { enum: ['active', 'delivered', 'archived'] }).notNull().default('active'),
  },
  (t) => [
    ...codeConstraints('features', t),
    uniqueIndex('uq_features_legacy_code').on(t.legacy_code),
    index('idx_features_project').on(t.project_id),
    index('idx_features_project_sort').on(t.project_id, t.sort_order),
    index('idx_features_module').on(t.module_id),
    index('idx_features_milestone').on(t.milestone_id),
  ],
);

export const requirements = pgTable(
  'requirements',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    feature_id: bigint('feature_id', { mode: 'bigint' }),
    module_id: bigint('module_id', { mode: 'bigint' }),
    document_id: bigint('document_id', { mode: 'bigint' }),
    title: text('title').notNull(),
    current_revision: integer('current_revision').notNull().default(0),
    state: text('state', {
      enum: ['draft', 'clarifying', 'confirmed', 'implementing', 'delivered', 'change_proposed', 'deprecated'],
    })
      .notNull()
      .default('draft'),
    owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    ...codeConstraints('requirements', t),
    uniqueIndex('uq_requirements_legacy_code').on(t.legacy_code),
    index('idx_requirements_feature').on(t.feature_id),
    index('idx_requirements_module').on(t.module_id),
    index('idx_requirements_document').on(t.document_id),
    index('idx_requirements_state').on(t.state),
  ],
);

/** 不可变 Revision：requirement_id + revision 唯一约束（docs/11）。 */
export const requirementRevisions = pgTable(
  'requirement_revisions',
  {
    id: identityId(),
    code: publicCode(),
    requirement_id: bigint('requirement_id', { mode: 'bigint' }).notNull(),
    revision: integer('revision').notNull(),
    summary: text('summary'),
    acceptance_criteria: text('acceptance_criteria').notNull(),
    open_questions: text('open_questions'),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('requirement_revisions', t),
    uniqueIndex('uq_requirement_revisions_requirement_revision').on(t.requirement_id, t.revision),
    index('idx_requirement_revisions_requirement').on(t.requirement_id),
  ],
);

export const defects = pgTable(
  'defects',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    feature_id: bigint('feature_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    severity: text('severity', { enum: ['critical', 'high', 'medium', 'low'] }).notNull(),
    reported_by: bigint('reported_by', { mode: 'bigint' }).notNull(),
    found_in: text('found_in'),
    description: text('description').notNull(),
    status: text('status', {
      enum: ['reported', 'triaged', 'fixing', 'retest', 'closed', 'rejected'],
    })
      .notNull()
      .default('reported'),
    related_requirement: bigint('related_requirement', { mode: 'bigint' }),
  },
  (t) => [
    ...codeConstraints('defects', t),
    uniqueIndex('uq_defects_legacy_code').on(t.legacy_code),
    index('idx_defects_feature').on(t.feature_id),
    index('idx_defects_status').on(t.status),
  ],
);

/** Approved immutable sets of exact requirement revisions. */
export const requirementBaselines = pgTable('requirement_baselines', {
  id: identityId(),
  code: publicCode(),
  project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  scope: text('scope').notNull(),
  reason: text('reason').notNull(),
  parent_baseline_id: bigint('parent_baseline_id', { mode: 'bigint' }),
  created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
  created_at: text('created_at').notNull(),
  content_hash: text('content_hash').notNull(),
}, (t) => [
  ...codeConstraints('requirement_baselines', t),
  uniqueIndex('uq_requirement_baselines_project_version').on(t.project_id, t.version),
  index('idx_requirement_baselines_project').on(t.project_id),
]);

export const requirementBaselineItems = pgTable('requirement_baseline_items', {
  baseline_id: bigint('baseline_id', { mode: 'bigint' }).notNull(),
  requirement_id: bigint('requirement_id', { mode: 'bigint' }).notNull(),
  requirement_revision_id: bigint('requirement_revision_id', { mode: 'bigint' }).notNull(),
  snapshot: text('snapshot').notNull(),
}, (t) => [
  primaryKey({ columns: [t.baseline_id, t.requirement_id] }),
  index('idx_requirement_baseline_items_revision').on(t.requirement_revision_id),
]);

export const tasks = pgTable(
  'tasks',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    feature_id: bigint('feature_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    brief: text('brief').notNull().default(''),
    profile: text('profile', { enum: ['planner', 'builder', 'verifier'] }).notNull(),
    source: text('source', { enum: ['requirement', 'ad-hoc', 'defect-fix', 'integration'] })
      .notNull()
      .default('requirement'),
    status: text('status', {
      enum: ['draft', 'ready', 'assigned', 'running', 'self_tested', 'submitted', 'verified', 'closed', 'blocked', 'failed', 'cancelled'],
    })
      .notNull()
      .default('draft'),
    requirement_id: bigint('requirement_id', { mode: 'bigint' }),
    source_requirement_revision_id: bigint('source_requirement_revision_id', { mode: 'bigint' }),
    source_document_revision_id: bigint('source_document_revision_id', { mode: 'bigint' }),
    requirement_baseline_id: bigint('requirement_baseline_id', { mode: 'bigint' }),
    defect_id: bigint('defect_id', { mode: 'bigint' }),
    assignee_principal_id: bigint('assignee_principal_id', { mode: 'bigint' }),
    acceptance: text('acceptance').notNull(),
    validation_seams: text('validation_seams'),
    scope: text('scope'),
    base_snapshot: integer('base_snapshot').notNull(),
    execution_epoch: integer('execution_epoch').notNull().default(0),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('tasks', t),
    uniqueIndex('uq_tasks_legacy_code').on(t.legacy_code),
    index('idx_tasks_feature').on(t.feature_id),
    index('idx_tasks_status').on(t.status),
    index('idx_tasks_assignee').on(t.assignee_principal_id),
    index('idx_tasks_requirement').on(t.requirement_id),
    index('idx_tasks_source_requirement_revision').on(t.source_requirement_revision_id),
    index('idx_tasks_source_document_revision').on(t.source_document_revision_id),
    index('idx_tasks_requirement_baseline').on(t.requirement_baseline_id),
    index('idx_tasks_defect').on(t.defect_id),
  ],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    task_id: bigint('task_id', { mode: 'bigint' }).notNull(),
    depends_on_task_id: bigint('depends_on_task_id', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.task_id, t.depends_on_task_id] }),
    index('idx_task_deps_on').on(t.depends_on_task_id),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    run_id: bigint('run_id', { mode: 'bigint' }).notNull().unique(),
    path: text('path').notNull(),
    git_base: text('git_base').notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [...codeConstraints('workspaces', t), uniqueIndex('uq_workspaces_legacy_code').on(t.legacy_code)],
);

export const runs = pgTable(
  'runs',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    task_id: bigint('task_id', { mode: 'bigint' }).notNull(),
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    profile: text('profile', { enum: ['planner', 'builder', 'verifier'] }).notNull(),
    workspace_id: bigint('workspace_id', { mode: 'bigint' }).notNull(),
    status: text('status', { enum: ['active', 'suspended', 'preparing', 'transferred', 'completed', 'failed', 'cancelled'] }).notNull().default('active'),
    base_snapshot: integer('base_snapshot').notNull(),
    continued_from_run_id: bigint('continued_from_run_id', { mode: 'bigint' }),
    handover_id: bigint('handover_id', { mode: 'bigint' }),
    context_snapshot_id: bigint('context_snapshot_id', { mode: 'bigint' }),
    execution_epoch: integer('execution_epoch').notNull().default(0),
    started_at: text('started_at').notNull(),
    finished_at: text('finished_at'),
  },
  (t) => [
    ...codeConstraints('runs', t),
    uniqueIndex('uq_runs_legacy_code').on(t.legacy_code),
    index('idx_runs_task').on(t.task_id),
    index('idx_runs_status').on(t.status),
    index('idx_runs_principal').on(t.principal_id),
    uniqueIndex('uq_runs_task_active').on(t.task_id).where(sql`status = 'active'`),
    index('idx_runs_continued_from').on(t.continued_from_run_id),
    uniqueIndex('uq_runs_handover_preparing').on(t.handover_id).where(sql`${t.status} = 'preparing'`),
  ],
);

/** Immutable task facts selected for another person to continue work. */
export const contextSnapshots = pgTable(
  'context_snapshots',
  {
    id: identityId(),
    code: publicCode(),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    task_id: bigint('task_id', { mode: 'bigint' }).notNull(),
    source_run_id: bigint('source_run_id', { mode: 'bigint' }).notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    manifest: text('manifest').notNull(),
    summary: text('summary').notNull(),
    material_versions: text('material_versions').notNull(),
    content_hash: text('content_hash').notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('context_snapshots', t),
    index('idx_context_snapshots_task').on(t.task_id),
    index('idx_context_snapshots_project').on(t.project_id),
  ],
);

export const taskHandovers = pgTable(
  'task_handovers',
  {
    id: identityId(),
    code: publicCode(),
    task_id: bigint('task_id', { mode: 'bigint' }).notNull(),
    source_run_id: bigint('source_run_id', { mode: 'bigint' }).notNull(),
    target_principal_id: bigint('target_principal_id', { mode: 'bigint' }).notNull(),
    source_device_id: bigint('source_device_id', { mode: 'bigint' }).notNull(),
    context_snapshot_id: bigint('context_snapshot_id', { mode: 'bigint' }),
    target_run_id: bigint('target_run_id', { mode: 'bigint' }),
    status: text('status', { enum: ['preparing', 'published', 'accepted', 'restoring', 'ready', 'completed', 'cancelled', 'expired'] }).notNull().default('preparing'),
    version: integer('version').notNull().default(0),
    source_epoch: integer('source_epoch').notNull(),
    preparation_grant_hash: text('preparation_grant_hash').notNull(),
    preparation_expires_at: text('preparation_expires_at').notNull(),
    workspace_manifest: text('workspace_manifest'),
    stop_ack: text('stop_ack'),
    attempt_code: text('attempt_code'),
    target_device_id: bigint('target_device_id', { mode: 'bigint' }),
    ready_receipt: text('ready_receipt'),
    drift_approval: text('drift_approval'),
    published_by: bigint('published_by', { mode: 'bigint' }),
    supersedes_handover_id: bigint('supersedes_handover_id', { mode: 'bigint' }),
    expires_at: text('expires_at').notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    last_error: text('last_error'),
  },
  (t) => [
    ...codeConstraints('task_handovers', t),
    check('ck_task_handovers_status', sql`${t.status} IN ('preparing', 'published', 'accepted', 'restoring', 'ready', 'completed', 'cancelled', 'expired')`),
    uniqueIndex('uq_task_handovers_unresolved').on(t.task_id).where(sql`${t.status} IN ('preparing', 'published', 'accepted', 'restoring', 'ready')`),
    uniqueIndex('uq_task_handovers_target_run').on(t.target_run_id).where(sql`${t.target_run_id} IS NOT NULL`),
    index('idx_task_handovers_target').on(t.target_principal_id, t.status),
  ],
);

export const runLeases = pgTable(
  'run_leases',
  {
    id: identityId(),
    code: publicCode(),
    run_id: bigint('run_id', { mode: 'bigint' }).notNull(),
    device_id: bigint('device_id', { mode: 'bigint' }).notNull(),
    epoch: integer('epoch').notNull(),
    token_hash: text('token_hash').notNull(),
    expires_at: text('expires_at').notNull(),
    revoked_at: text('revoked_at'),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('run_leases', t),
    uniqueIndex('uq_run_leases_unrevoked').on(t.run_id).where(sql`${t.revoked_at} IS NULL`),
    index('idx_run_leases_device').on(t.device_id),
  ],
);

/** Domain command replay results exclude bearer credentials. */
export const commandReceipts = pgTable(
  'command_receipts',
  {
    id: identityId(),
    code: publicCode(),
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    device_id: bigint('device_id', { mode: 'bigint' }),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    request_hash: text('request_hash').notNull(),
    result: text('result').notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('command_receipts', t),
    uniqueIndex('uq_command_receipts_command').on(t.principal_id, t.operation, t.key),
  ],
);

/** 本地执行面中的 Agent 会话；每条记录严格绑定一个平台 Run。 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    run_id: bigint('run_id', { mode: 'bigint' }).notNull(),
    agent_command: text('agent_command').notNull(),
    start_key: text('start_key'),
    device_id: bigint('device_id', { mode: 'bigint' }),
    execution_epoch: integer('execution_epoch').notNull().default(0),
    launch_kind: text('launch_kind', { enum: ['default', 'custom'] }).notNull(),
    prompt_path: text('prompt_path'),
    resumed_from_session_id: bigint('resumed_from_session_id', { mode: 'bigint' }),
    process_id: integer('process_id'),
    status: text('status', { enum: ['starting', 'running', 'completed', 'finished', 'failed', 'cancelled'] }).notNull(),
    started_at: text('started_at').notNull(),
    finished_at: text('finished_at'),
    exit_code: integer('exit_code'),
    last_error: text('last_error'),
    last_output: text('last_output'),
  },
  (t) => [
    ...codeConstraints('agent_sessions', t),
    uniqueIndex('uq_agent_sessions_legacy_code').on(t.legacy_code),
    index('idx_agent_sessions_run_started').on(t.run_id, t.started_at),
    index('idx_agent_sessions_status').on(t.status),
    uniqueIndex('uq_agent_sessions_start').on(t.run_id, t.device_id, t.execution_epoch, t.start_key).where(sql`${t.start_key} IS NOT NULL`),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    task_id: bigint('task_id', { mode: 'bigint' }),
    run_id: bigint('run_id', { mode: 'bigint' }),
    kind: text('kind', { enum: ['commit', 'document', 'prototype', 'report', 'other'] }).notNull(),
    title: text('title'),
    summary: text('summary'),
    uri: text('uri').notNull(),
    content_hash: text('content_hash').notNull(),
    published: boolean('published').notNull().default(false),
    published_at: text('published_at'),
  },
  (t) => [
    ...codeConstraints('artifacts', t),
    uniqueIndex('uq_artifacts_legacy_code').on(t.legacy_code),
    index('idx_artifacts_project').on(t.project_id),
    index('idx_artifacts_task').on(t.task_id),
  ],
);

export const evidences = pgTable(
  'evidences',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    task_id: bigint('task_id', { mode: 'bigint' }).notNull(),
    run_id: bigint('run_id', { mode: 'bigint' }),
    type: text('type', { enum: ['self_test', 'verifier_review', 'deployment', 'manual'] }).notNull(),
    acceptance_refs: text('acceptance_refs'),
    result: text('result', { enum: ['pass', 'fail', 'inconclusive'] }).notNull(),
    command: text('command'),
    summary: text('summary'),
    report_uri: text('report_uri'),
    recorded_at: text('recorded_at').notNull(),
  },
  (t) => [
    ...codeConstraints('evidences', t),
    uniqueIndex('uq_evidences_legacy_code').on(t.legacy_code),
    index('idx_evidences_task').on(t.task_id),
    index('idx_evidences_type').on(t.type),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    timestamp: text('timestamp').notNull(),
    principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
    run_id: bigint('run_id', { mode: 'bigint' }),
    action: text('action').notNull(),
    entity_type: text('entity_type').notNull(),
    entity_id: bigint('entity_id', { mode: 'bigint' }),
    legacy_entity_code: text('legacy_entity_code'),
    base_snapshot: integer('base_snapshot').notNull(),
    from_state: text('from_state'),
    to_state: text('to_state'),
    payload: text('payload'),
  },
  (t) => [
    ...codeConstraints('audit_events', t),
    uniqueIndex('uq_audit_events_legacy_code').on(t.legacy_code),
    index('idx_audit_entity').on(t.entity_type, t.entity_id),
    index('idx_audit_principal').on(t.principal_id),
  ],
);

/** Context Graph 本体：快照与节点/边都通过数字 graph_id 归属到同一张图。 */
export const contextGraphs = pgTable(
  'context_graphs',
  {
    id: identityId(),
    code: publicCode(),
    legacy_code: text('legacy_code'),
    project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('context_graphs', t),
    uniqueIndex('uq_context_graphs_legacy_code').on(t.legacy_code),
    index('idx_context_graphs_project').on(t.project_id),
  ],
);

/** Context Graph 快照：graph_snapshot 仍保留 integer 版本号。 */
export const contextGraphSnapshots = pgTable(
  'context_graph_snapshots',
  {
    id: identityId(),
    code: publicCode(),
    graph_id: bigint('graph_id', { mode: 'bigint' }).notNull(),
    graph_snapshot: integer('graph_snapshot').notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    ...codeConstraints('context_graph_snapshots', t),
    uniqueIndex('uq_context_graph_snapshots_graph_snapshot').on(t.graph_id, t.graph_snapshot),
    index('idx_context_graph_snapshots_graph').on(t.graph_id, t.graph_snapshot),
  ],
);

export const contextNodes = pgTable(
  'context_nodes',
  {
    id: identityId(),
    code: publicCode(),
    snapshot_id: bigint('snapshot_id', { mode: 'bigint' }).notNull(),
    node_key: text('node_key').notNull(),
    kind: text('kind').notNull(),
    verification: text('verification', { enum: ['proposed', 'inferred', 'confirmed'] }).notNull(),
    freshness: text('freshness', { enum: ['current', 'stale', 'unknown'] }).notNull(),
    payload: text('payload'),
  },
  (t) => [
    ...codeConstraints('context_nodes', t),
    uniqueIndex('uq_context_nodes_snapshot_key').on(t.snapshot_id, t.node_key),
    index('idx_nodes_snapshot').on(t.snapshot_id),
    index('idx_nodes_snapshot_key').on(t.snapshot_id, t.node_key),
  ],
);

export const contextEdges = pgTable(
  'context_edges',
  {
    id: identityId(),
    code: publicCode(),
    legacy_key: text('legacy_key'),
    snapshot_id: bigint('snapshot_id', { mode: 'bigint' }).notNull(),
    from_node_id: bigint('from_node_id', { mode: 'bigint' }).notNull(),
    to_node_id: bigint('to_node_id', { mode: 'bigint' }).notNull(),
    relation: text('relation').notNull(),
    verification: text('verification', { enum: ['proposed', 'inferred', 'confirmed'] }).notNull(),
    freshness: text('freshness', { enum: ['current', 'stale', 'unknown'] }).notNull(),
  },
  (t) => [
    ...codeConstraints('context_edges', t),
    uniqueIndex('uq_context_edges_snapshot_legacy_key').on(t.snapshot_id, t.legacy_key),
    index('idx_edges_snapshot').on(t.snapshot_id),
    index('idx_edges_from').on(t.from_node_id, t.snapshot_id),
    index('idx_edges_to').on(t.to_node_id, t.snapshot_id),
  ],
);


/** Test definitions are versioned independently; execution snapshots never follow later edits. */
function testDocumentColumns() { return {
  id: identityId(), code: publicCode(), project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
  title: text('title').notNull(), summary: text('summary').notNull(), current_revision: integer('current_revision').notNull(),
  owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }).notNull(),
  created_at: text('created_at').notNull(), updated_at: text('updated_at').notNull(),
}; }
function testRevisionColumns() { return {
  id: identityId(), code: publicCode(), document_id: bigint('document_id', { mode: 'bigint' }).notNull(),
  revision: integer('revision').notNull(), content_json: text('content_json').notNull(),
  change_summary: text('change_summary').notNull(), created_by: bigint('created_by', { mode: 'bigint' }).notNull(), created_at: text('created_at').notNull(),
}; }
export const testCases = pgTable('test_cases', testDocumentColumns(), t => [
  ...codeConstraints('test_cases', t), index('idx_test_cases_project').on(t.project_id), check('ck_test_cases_revision', sql`${t.current_revision} > 0`),
]);
export const testCaseRevisions = pgTable('test_case_revisions', testRevisionColumns(), t => [
  ...codeConstraints('test_case_revisions', t), uniqueIndex('uq_test_case_revisions_document_revision').on(t.document_id, t.revision), check('ck_test_case_revisions_revision', sql`${t.revision} > 0`),
]);
export const testAssets = pgTable('test_assets', testDocumentColumns(), t => [
  ...codeConstraints('test_assets', t), index('idx_test_assets_project').on(t.project_id), check('ck_test_assets_revision', sql`${t.current_revision} > 0`),
]);
export const testAssetRevisions = pgTable('test_asset_revisions', testRevisionColumns(), t => [
  ...codeConstraints('test_asset_revisions', t), uniqueIndex('uq_test_asset_revisions_document_revision').on(t.document_id, t.revision), check('ck_test_asset_revisions_revision', sql`${t.revision} > 0`),
]);
export const testExecutions = pgTable('test_executions', {
  id: identityId(), code: publicCode(), project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
  title: text('title').notNull(), environment: text('environment').notNull(), tested_version: text('tested_version').notNull(),
  commit_sha: text('commit_sha').notNull(), source: text('source', { enum: ['manual', 'agent', 'ci'] }).notNull(),
  task_code: text('task_code'), notes_markdown: text('notes_markdown').notNull(), assets_json: text('assets_json').notNull(),
  executor_principal_id: bigint('executor_principal_id', { mode: 'bigint' }).notNull(), created_at: text('created_at').notNull(),
}, t => [...codeConstraints('test_executions', t), index('idx_test_executions_project').on(t.project_id), check('ck_test_executions_source', sql`${t.source} in ('manual', 'agent', 'ci')`)]);
export const testExecutionResults = pgTable('test_execution_results', {
  id: identityId(), code: publicCode(), execution_id: bigint('execution_id', { mode: 'bigint' }).notNull(),
  case_code: text('case_code').notNull(), case_revision: integer('case_revision').notNull(),
  result: text('result', { enum: ['not_run', 'pass', 'fail', 'blocked', 'skipped'] }).notNull(),
  actual_result: text('actual_result').notNull(), notes: text('notes').notNull(), report_urls_json: text('report_urls_json').notNull(),
  snapshot_json: text('snapshot_json').notNull(), defect_code: text('defect_code'),
}, t => [...codeConstraints('test_execution_results', t), uniqueIndex('uq_test_execution_results_case').on(t.execution_id, t.case_code),
  check('ck_test_execution_results_revision', sql`${t.case_revision} > 0`), check('ck_test_execution_results_result', sql`${t.result} in ('not_run', 'pass', 'fail', 'blocked', 'skipped')`)]);

export const skills = pgTable('skills', {
  id: identityId(), code: publicCode(), scope_type: text('scope_type', { enum: ['team', 'project'] }).notNull(),
  scope_id: bigint('scope_id', { mode: 'bigint' }).notNull(), owner_principal_id: bigint('owner_principal_id', { mode: 'bigint' }).notNull(),
  current_revision: integer('current_revision').notNull(), archived: boolean('archived').notNull().default(false),
  created_at: text('created_at').notNull(), updated_at: text('updated_at').notNull(),
}, t => [...codeConstraints('skills', t), index('idx_skills_scope').on(t.scope_type, t.scope_id),
  check('ck_skills_scope', sql`${t.scope_type} in ('team', 'project')`), check('ck_skills_revision', sql`${t.current_revision} > 0`)]);
export const skillRevisions = pgTable('skill_revisions', {
  id: identityId(), code: publicCode(), skill_id: bigint('skill_id', { mode: 'bigint' }).notNull(), revision: integer('revision').notNull(),
  package_json: text('package_json').notNull(), change_summary: text('change_summary').notNull(),
  created_by: bigint('created_by', { mode: 'bigint' }).notNull(), created_at: text('created_at').notNull(), published_at: text('published_at'),
}, t => [...codeConstraints('skill_revisions', t), uniqueIndex('uq_skill_revisions_number').on(t.skill_id, t.revision), check('ck_skill_revisions_number', sql`${t.revision} > 0`)]);
export const skillShares = pgTable('skill_shares', {
  id: identityId(), code: publicCode(), skill_id: bigint('skill_id', { mode: 'bigint' }).notNull(),
  target_type: text('target_type', { enum: ['team', 'project'] }).notNull(), target_id: bigint('target_id', { mode: 'bigint' }).notNull(),
  revisions_json: text('revisions_json').notNull(), allow_projects: boolean('allow_projects').notNull().default(false),
  allow_external: boolean('allow_external').notNull().default(false), created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
  created_at: text('created_at').notNull(), revoked_at: text('revoked_at'), revoked_by: bigint('revoked_by', { mode: 'bigint' }),
}, t => [...codeConstraints('skill_shares', t), index('idx_skill_shares_target').on(t.target_type, t.target_id),
  index('idx_skill_shares_skill').on(t.skill_id), check('ck_skill_shares_target', sql`${t.target_type} in ('team', 'project')`)]);
export const projectSkillStates = pgTable('project_skill_states', {
  project_id: bigint('project_id', { mode: 'bigint' }).primaryKey(), generation: integer('generation').notNull().default(0),
}, t => [check('ck_project_skill_generation', sql`${t.generation} >= 0`)]);
export const projectSkillInstallations = pgTable('project_skill_installations', {
  id: identityId(), project_id: bigint('project_id', { mode: 'bigint' }).notNull(), skill_id: bigint('skill_id', { mode: 'bigint' }).notNull(),
  revision: integer('revision').notNull(), alias: text('alias').notNull(), enabled: boolean('enabled').notNull(),
  updated_by: bigint('updated_by', { mode: 'bigint' }).notNull(), updated_at: text('updated_at').notNull(),
}, t => [uniqueIndex('uq_project_skill_installation').on(t.project_id, t.skill_id), uniqueIndex('uq_project_skill_alias').on(t.project_id, t.alias),
  check('ck_project_skill_revision', sql`${t.revision} > 0`)]);
export const runSkillManifests = pgTable('run_skill_manifests', {
  run_id: bigint('run_id', { mode: 'bigint' }).primaryKey(), manifest_json: text('manifest_json').notNull(), created_at: text('created_at').notNull(),
});

/** Candidate packages are isolated from business entities until an explicit reviewed plan is applied. */
export const intakeBatches = pgTable('intake_batches', {
  id: identityId(), code: publicCode(), project_id: bigint('project_id', { mode: 'bigint' }).notNull(),
  repository_id: bigint('repository_id', { mode: 'bigint' }).notNull(), namespace: text('namespace').notNull(),
  created_by: bigint('created_by', { mode: 'bigint' }).notNull(), source_json: text('source_json').notNull(),
  payload_hash: text('payload_hash').notNull(), submit_key: text('submit_key').notNull(), submit_hash: text('submit_hash').notNull(),
  status: text('status', { enum: ['draft', 'ready', 'applying', 'applied', 'partial', 'cancelled', 'stopped'] }).notNull(),
  revision: integer('revision').notNull().default(1), plan_hash: text('plan_hash'),
  stop_requested: boolean('stop_requested').notNull().default(false),
  created_at: text('created_at').notNull(), updated_at: text('updated_at').notNull(),
}, t => [...codeConstraints('intake_batches', t), index('idx_intake_batches_project').on(t.project_id),
  uniqueIndex('uq_intake_batches_submit').on(t.project_id, t.created_by, t.submit_key),
  check('ck_intake_batches_status', sql`${t.status} in ('draft','ready','applying','applied','partial','cancelled','stopped')`),
  check('ck_intake_batches_revision', sql`${t.revision} > 0`)]);
export const intakeItems = pgTable('intake_items', {
  id: identityId(), batch_id: bigint('batch_id', { mode: 'bigint' }).notNull(), item_key: text('item_key').notNull(),
  kind: text('kind').notNull(), item_json: text('item_json').notNull(), decision_json: text('decision_json'),
  status: text('status', { enum: ['pending', 'applied', 'bound', 'skipped', 'failed', 'blocked'] }).notNull().default('pending'),
  target_code: text('target_code'), error: text('error'),
}, t => [uniqueIndex('uq_intake_items_key').on(t.batch_id, t.item_key),
  check('ck_intake_items_kind', sql`${t.kind} in ('module','feature','requirement_document','requirement','architecture')`),
  check('ck_intake_items_status', sql`${t.status} in ('pending','applied','bound','skipped','failed','blocked')`)]);
export const intakeBindings = pgTable('intake_bindings', {
  id: identityId(), project_id: bigint('project_id', { mode: 'bigint' }).notNull(), repository_id: bigint('repository_id', { mode: 'bigint' }).notNull(),
  namespace: text('namespace').notNull(), kind: text('kind').notNull(), source_key: text('source_key').notNull(),
  target_code: text('target_code').notNull(), target_fingerprint: text('target_fingerprint').notNull(),
  batch_id: bigint('batch_id', { mode: 'bigint' }).notNull(), created_at: text('created_at').notNull(),
}, t => [uniqueIndex('uq_intake_bindings_source').on(t.project_id, t.repository_id, t.namespace, t.kind, t.source_key)]);
export const intakeAttempts = pgTable('intake_attempts', {
  id: identityId(), batch_id: bigint('batch_id', { mode: 'bigint' }).notNull(), idempotency_key: text('idempotency_key').notNull(),
  plan_hash: text('plan_hash').notNull(), principal_id: bigint('principal_id', { mode: 'bigint' }).notNull(),
  status: text('status', { enum: ['running', 'completed', 'stopped'] }).notNull(),
  results_json: text('results_json').notNull().default('[]'), created_at: text('created_at').notNull(), finished_at: text('finished_at'),
}, t => [uniqueIndex('uq_intake_attempts_request').on(t.batch_id, t.idempotency_key),
  uniqueIndex('uq_intake_attempts_running').on(t.batch_id).where(sql`${t.status} = 'running'`),
  check('ck_intake_attempts_status', sql`${t.status} in ('running','completed','stopped')`)]);
