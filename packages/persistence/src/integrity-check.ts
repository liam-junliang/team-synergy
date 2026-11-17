import { performance } from 'node:perf_hooks';
import type { Db } from './db.js';
import { withReadOnlySnapshot } from './read-only-snapshot.js';

interface IntegrityRule { readonly name: string; readonly references: readonly string[]; readonly query: string }
/** Explicit reviewed parent tables. Never infer SQL identifiers from caller input or payloads. */
const parents = {
  agent_sessions: 'run_id:runs device_id:devices resumed_from_session_id:agent_sessions',
  architecture_document_revisions: 'document_id:architecture_documents created_by:users',
  architecture_documents: 'project_id:projects owner_principal_id:users',
  artifacts: 'project_id:projects task_id:tasks run_id:runs',
  audit_events: 'principal_id:users run_id:runs',
  auth_security_events: 'principal_id:users',
  command_receipts: 'principal_id:users device_id:devices',
  code_understanding_runs: 'project_id:projects repository_id:project_repositories created_by:users',
  code_hosted_analysis_jobs: 'project_id:projects repository_id:project_repositories requester_id:users',
  code_understanding_views: 'project_id:projects created_by:users',
  code_understanding_selections: 'project_id:projects selected_by:users',
  code_understanding_excerpt_budgets: 'project_id:projects',
  memory_capture_jobs: 'project_id:projects principal_id:users',
  memory_capture_receipts: 'project_id:projects principal_id:users topic_id:requirement_topics requirement_id:requirements',
  memory_fragments: 'receipt_id:memory_capture_receipts entry_id:requirement_topic_entries adopted_from_id:memory_fragments root_id:memory_fragments supersedes_id:memory_fragments withdrawn_by:users',
  memory_projection_jobs: 'fragment_id:memory_fragments project_document_revision_id:project_document_revisions material_index_id:project_material_index_versions',
  project_memory_bindings: 'project_id:projects updated_by:users',
  project_material_index_events: 'project_id:projects',
  project_material_index_versions: 'project_id:projects',
  context_edges: 'snapshot_id:context_graph_snapshots from_node_id:context_nodes to_node_id:context_nodes',
  context_graph_snapshots: 'graph_id:context_graphs',
  context_graphs: 'project_id:projects',
  context_nodes: 'snapshot_id:context_graph_snapshots',
  context_snapshots: 'project_id:projects task_id:tasks source_run_id:runs created_by:users',
  defects: 'feature_id:features reported_by:users related_requirement:requirements',
  defect_evidence_files: 'defect_id:defects',
  design_prototype_requirements: 'prototype_id:design_prototypes requirement_id:requirements',
  design_prototype_revisions: 'prototype_id:design_prototypes created_by:users',
  design_prototypes: 'project_id:projects owner_principal_id:users',
  device_authorization_requests: 'principal_id:users',
  device_sessions: 'device_id:devices',
  devices: 'principal_id:users',
  evidences: 'task_id:tasks run_id:runs',
  features: 'project_id:projects module_id:project_modules milestone_id:project_milestones',
  intake_attempts: 'batch_id:intake_batches principal_id:users',
  intake_batches: 'project_id:projects repository_id:project_repositories created_by:users',
  intake_bindings: 'project_id:projects repository_id:project_repositories batch_id:intake_batches',
  intake_items: 'batch_id:intake_batches',
  members: 'principal_id:users project_id:projects',
  ownership_transfers: 'from_principal_id:users to_principal_id:users initiated_by:users',
  project_document_folders: 'project_id:projects parent_id:project_document_folders created_by:users',
  project_document_revisions: 'document_id:project_documents created_by:users',
  project_documents: 'project_id:projects folder_id:project_document_folders created_by:users updated_by:users',
  project_milestones: 'project_id:projects phase_id:project_phases owner_principal_id:users',
  project_modules: 'project_id:projects',
  project_orders: 'project_id:projects principal_id:users',
  project_phases: 'project_id:projects',
  project_repositories: 'project_id:projects created_by:users',
  project_skill_installations: 'project_id:projects skill_id:skills updated_by:users',
  project_skill_states: 'project_id:projects',
  project_workspaces: 'project_id:projects principal_id:users',
  projects: 'team_id:teams created_by:users owner_principal_id:users overview_document_id:project_documents guide_document_id:project_documents standards_document_id:project_documents',
  requirement_baseline_items: 'baseline_id:requirement_baselines requirement_id:requirements requirement_revision_id:requirement_revisions',
  requirement_baselines: 'project_id:projects parent_baseline_id:requirement_baselines created_by:users',
  requirement_document_review_votes: 'review_id:requirement_document_reviews principal_id:users',
  requirement_document_reviews: 'document_revision_id:requirement_document_revisions requested_by:users closed_by:users',
  requirement_document_revisions: 'document_id:requirement_documents created_by:users',
  requirement_documents: 'project_id:projects module_id:project_modules owner_principal_id:users',
  requirement_ideas: 'project_id:projects created_by:users',
  requirement_revisions: 'requirement_id:requirements',
  requirement_topic_documents: 'topic_id:requirement_topics document_id:requirement_documents',
  requirement_topic_entries: 'topic_id:requirement_topics supersedes_entry_id:requirement_topic_entries author_principal_id:users withdrawn_by:users',
  requirement_topic_entry_images: 'entry_id:requirement_topic_entries',
  requirement_topic_ideas: 'topic_id:requirement_topics idea_id:requirement_ideas',
  requirement_topics: 'project_id:projects created_by:users',
  requirements: 'feature_id:features module_id:project_modules document_id:requirement_documents owner_principal_id:users',
  run_leases: 'run_id:runs device_id:devices',
  run_skill_manifests: 'run_id:runs',
  runs: 'task_id:tasks principal_id:users workspace_id:workspaces continued_from_run_id:runs handover_id:task_handovers context_snapshot_id:context_snapshots',
  skill_revisions: 'skill_id:skills created_by:users',
  skill_shares: 'skill_id:skills created_by:users revoked_by:users',
  skills: 'owner_principal_id:users',
  system_agent_jobs: 'project_id:projects document_id:project_documents requester_id:users applied_by:users',
  system_settings: 'updated_by:users',
  task_dependencies: 'task_id:tasks depends_on_task_id:tasks',
  task_handovers: 'task_id:tasks source_run_id:runs target_principal_id:users source_device_id:devices context_snapshot_id:context_snapshots target_run_id:runs target_device_id:devices published_by:users supersedes_handover_id:task_handovers',
  tasks: 'feature_id:features requirement_id:requirements source_requirement_revision_id:requirement_revisions source_document_revision_id:requirement_document_revisions requirement_baseline_id:requirement_baselines defect_id:defects assignee_principal_id:users',
  team_members: 'team_id:teams principal_id:users',
  teams: 'created_by:users owner_principal_id:users',
  test_asset_revisions: 'document_id:test_assets created_by:users',
  test_assets: 'project_id:projects owner_principal_id:users',
  test_case_revisions: 'document_id:test_cases created_by:users',
  test_cases: 'project_id:projects owner_principal_id:users',
  test_execution_results: 'execution_id:test_executions',
  test_executions: 'project_id:projects executor_principal_id:users',
  workspaces: 'run_id:runs',
} as const;

const identifier = (name: string) => { if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid integrity catalog'); return `"${name}"`; };
const rule = (name: string, query: string, ...references: string[]): IntegrityRule => Object.freeze({ name, query, references: Object.freeze(references) });
const reference = (table: string, column: string, target: string, filter = '', suffix = '') => rule(`${table}.${column}${suffix}`,
  `SELECT count(*)::text AS count FROM ${identifier(table)} s WHERE s.${identifier(column)} IS NOT NULL ${filter} AND NOT EXISTS (SELECT 1 FROM ${identifier(target)} p WHERE p.id = s.${identifier(column)})`, `${table}.${column}`);
const ordinary = Object.entries(parents).flatMap(([table, fields]) => fields.split(' ').filter(Boolean).map(field => {
  const [column = '', target = ''] = field.split(':'); return reference(table, column, target);
}));
const auditTypes = {
  user: 'users', team: 'teams', project: 'projects', feature: 'features', task: 'tasks', run: 'runs', device: 'devices',
  agent_session: 'agent_sessions', defect: 'defects', requirement: 'requirements', requirement_revision: 'requirement_revisions',
  project_module: 'project_modules', project_phase: 'project_phases', project_milestone: 'project_milestones',
  project_document: 'project_documents', project_document_folder: 'project_document_folders', project_repository: 'project_repositories',
  requirement_document: 'requirement_documents', requirement_idea: 'requirement_ideas', requirement_topic: 'requirement_topics',
  requirement_topic_entry: 'requirement_topic_entries', requirement_document_review: 'requirement_document_reviews',
  requirement_baseline: 'requirement_baselines', architecture_document: 'architecture_documents', design_prototype: 'design_prototypes',
  test_case: 'test_cases', test_asset: 'test_assets', test_execution: 'test_executions', skill: 'skills', system_agent_job: 'system_agent_jobs', system_settings: 'system_settings', intake_batch: 'intake_batches',
} as const;
const polymorphic = Object.entries(auditTypes).map(([kind, target]) => reference('audit_events', 'entity_id', target, `AND s.entity_type = '${kind}'`, `.${kind}`));
polymorphic.push(rule('audit_events.entity_id.unknown_type', `SELECT count(*)::text AS count FROM audit_events WHERE entity_id IS NOT NULL AND entity_type NOT IN (${Object.keys(auditTypes).map(kind => `'${kind}'`).join(',')})`, 'audit_events.entity_id'));
for (const [table, column, discriminator] of [['skills', 'scope_id', 'scope_type'], ['skill_shares', 'target_id', 'target_type'], ['ownership_transfers', 'scope_id', 'scope']] as const) {
  for (const [kind, target] of [['team', 'teams'], ['project', 'projects']] as const) polymorphic.push(reference(table, column, target, `AND s.${identifier(discriminator)} = '${kind}'`, `.${kind}`));
  polymorphic.push(rule(`${table}.${column}.unknown_type`, `SELECT count(*)::text AS count FROM ${identifier(table)} WHERE ${identifier(column)} IS NOT NULL AND ${identifier(discriminator)} NOT IN ('team','project')`, `${table}.${column}`));
}

/** Compare scope only when both referenced records exist; missing records have their own orphan counts. */
const sameScope = (table: string, column: string, target: string, scope = 'project_id', targetScope = scope) => rule(`${table}.${column}.same_${scope}`,
  `SELECT count(*)::text AS count FROM ${identifier(table)} s JOIN ${identifier(target)} p ON p.id=s.${identifier(column)} WHERE s.${identifier(scope)} IS DISTINCT FROM p.${identifier(targetScope)}`, `${table}.${column}`);
const scopeRules = [
  sameScope('code_understanding_runs','repository_id','project_repositories'),
  sameScope('code_hosted_analysis_jobs','repository_id','project_repositories'),
  rule('code_hosted_analysis_jobs.run_code', 'SELECT count(*)::text AS count FROM code_hosted_analysis_jobs j WHERE j.run_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM code_understanding_runs r WHERE r.code=j.run_code)', 'code_hosted_analysis_jobs.run_code'),
  rule('code_hosted_analysis_jobs.run_code.same_project', 'SELECT count(*)::text AS count FROM code_hosted_analysis_jobs j JOIN code_understanding_runs r ON r.code=j.run_code WHERE j.project_id<>r.project_id OR j.repository_id<>r.repository_id OR j.requester_id<>r.created_by', 'code_hosted_analysis_jobs.run_code'),
  rule('code_understanding_selections.view_code.same_project', 'SELECT count(*)::text AS count FROM code_understanding_selections s JOIN code_understanding_views v ON v.code=s.view_code WHERE s.project_id<>v.project_id OR s.kind<>v.kind', 'code_understanding_selections.view_code'),
  ...['overview_document_id','guide_document_id','standards_document_id'].map(column => rule(`projects.${column}.same_project`, `SELECT count(*)::text AS count FROM projects s JOIN project_documents p ON p.id=s.${column} WHERE s.id<>p.project_id`, `projects.${column}`)),
  sameScope('project_document_folders','parent_id','project_document_folders'),
  sameScope('project_documents','folder_id','project_document_folders'),
  sameScope('system_agent_jobs','document_id','project_documents'),
  sameScope('project_milestones','phase_id','project_phases'),
  sameScope('requirement_documents','module_id','project_modules'),
  sameScope('features','module_id','project_modules'), sameScope('features','milestone_id','project_milestones'),
  sameScope('intake_batches','repository_id','project_repositories'), sameScope('intake_bindings','repository_id','project_repositories'),
  sameScope('intake_bindings','batch_id','intake_batches'),
  sameScope('requirement_baselines','parent_baseline_id','requirement_baselines'),
  sameScope('runs','continued_from_run_id','runs','task_id'), sameScope('runs','handover_id','task_handovers','task_id'),
  sameScope('runs','context_snapshot_id','context_snapshots','task_id'),
  sameScope('task_handovers','source_run_id','runs','task_id'), sameScope('task_handovers','target_run_id','runs','task_id'),
  sameScope('task_handovers','context_snapshot_id','context_snapshots','task_id'), sameScope('task_handovers','supersedes_handover_id','task_handovers','task_id'),
  sameScope('context_snapshots','source_run_id','runs','task_id'), sameScope('evidences','run_id','runs','task_id'),
  sameScope('context_edges','from_node_id','context_nodes','snapshot_id'), sameScope('context_edges','to_node_id','context_nodes','snapshot_id'),
  rule('runs.workspace_id.reciprocal', 'SELECT count(*)::text AS count FROM runs s JOIN workspaces p ON p.id=s.workspace_id WHERE p.run_id<>s.id', 'runs.workspace_id','workspaces.run_id'),
  rule('agent_sessions.device_id.same_principal', 'SELECT count(*)::text AS count FROM agent_sessions s JOIN runs r ON r.id=s.run_id JOIN devices d ON d.id=s.device_id WHERE d.principal_id<>r.principal_id', 'agent_sessions.device_id'),
  rule('run_leases.device_id.same_principal', 'SELECT count(*)::text AS count FROM run_leases s JOIN runs r ON r.id=s.run_id JOIN devices d ON d.id=s.device_id WHERE d.principal_id<>r.principal_id', 'run_leases.device_id'),
  rule('command_receipts.device_id.same_principal', 'SELECT count(*)::text AS count FROM command_receipts s JOIN devices p ON p.id=s.device_id WHERE p.principal_id<>s.principal_id', 'command_receipts.device_id'),
];
// Requirements have no direct project_id: compare every non-null structural parent pair.
for (const [left, leftTable, right, rightTable] of [['feature_id','features','module_id','project_modules'],['feature_id','features','document_id','requirement_documents'],['module_id','project_modules','document_id','requirement_documents']]) {
  scopeRules.push(rule(`requirements.${left}.${right}.same_project`, `SELECT count(*)::text AS count FROM requirements s JOIN ${leftTable} l ON l.id=s.${left} JOIN ${rightTable} r ON r.id=s.${right} WHERE l.project_id<>r.project_id`, `requirements.${left}`, `requirements.${right}`));
}
for (const [table, column, target, targetProjectJoin] of [
  ['tasks','defect_id','defects','JOIN features tf ON tf.id=p.feature_id'],
  ['tasks','requirement_baseline_id','requirement_baselines',''],
  ['context_snapshots','task_id','tasks','JOIN features tf ON tf.id=p.feature_id'],
  ['artifacts','task_id','tasks','JOIN features tf ON tf.id=p.feature_id'],
] as const) {
  const task = table === 'tasks';
  const source = task ? 'JOIN features sf ON sf.id=s.feature_id' : '';
  const sourceProject = task ? 'sf.project_id' : 's.project_id';
  const targetProject = targetProjectJoin ? 'tf.project_id' : 'p.project_id';
  scopeRules.push(rule(`${table}.${column}.same_project`, `SELECT count(*)::text AS count FROM ${table} s ${source} JOIN ${target} p ON p.id=s.${column} ${targetProjectJoin} WHERE ${sourceProject}<>${targetProject}`, `${table}.${column}`));
}
for (const [table, column, referenceColumn, target] of [['tasks','source_requirement_revision_id','requirement_id','requirement_revisions'],['requirement_baseline_items','requirement_revision_id','requirement_id','requirement_revisions']]) {
  scopeRules.push(rule(`${table}.${column}.same_requirement`, `SELECT count(*)::text AS count FROM ${table} s JOIN ${target} p ON p.id=s.${column} WHERE s.${referenceColumn} IS DISTINCT FROM p.requirement_id`, `${table}.${column}`));
}

// Scope projections are explicit domain paths, not guesses based on column names.
const requirementProject = `SELECT r.id, coalesce(f.project_id,m.project_id,d.project_id) AS project_id FROM requirements r LEFT JOIN features f ON f.id=r.feature_id LEFT JOIN project_modules m ON m.id=r.module_id LEFT JOIN requirement_documents d ON d.id=r.document_id`;
const taskProject = 'SELECT t.id,f.project_id FROM tasks t JOIN features f ON f.id=t.feature_id';
const runProject = `SELECT r.id,t.project_id FROM runs r JOIN (${taskProject}) t ON t.id=r.task_id`;
const projectScopes: Record<string,string> = {
  projects: 'SELECT id,id AS project_id FROM projects', requirements: requirementProject, tasks: taskProject, runs: runProject,
};
for (const table of ['project_repositories','project_workspaces','project_document_folders','project_documents','system_agent_jobs','code_hosted_analysis_jobs',
  'project_modules','project_phases','project_milestones','requirement_documents','requirement_ideas','requirement_topics','design_prototypes',
  'architecture_documents','features','requirement_baselines','context_snapshots','artifacts','context_graphs','test_cases','test_assets',
  'test_executions','intake_batches','intake_bindings','project_skill_installations','memory_capture_jobs','memory_capture_receipts','project_memory_bindings']) projectScopes[table] = `SELECT id,project_id FROM ${table}`;
for (const [table,column,target] of [
  ['memory_fragments','receipt_id','memory_capture_receipts'],['memory_projection_jobs','fragment_id','memory_fragments'],
  ['project_document_revisions','document_id','project_documents'],['requirement_document_revisions','document_id','requirement_documents'],
  ['architecture_document_revisions','document_id','architecture_documents'],['design_prototype_revisions','prototype_id','design_prototypes'],
  ['requirement_topic_entries','topic_id','requirement_topics'],['requirement_topic_ideas','topic_id','requirement_topics'],
  ['requirement_topic_documents','topic_id','requirement_topics'],['design_prototype_requirements','prototype_id','design_prototypes'],
  ['defects','feature_id','features'],['requirement_revisions','requirement_id','requirements'],
  ['requirement_baseline_items','baseline_id','requirement_baselines'],['task_dependencies','task_id','tasks'],
  ['workspaces','run_id','runs'],['task_handovers','task_id','tasks'],['evidences','task_id','tasks'],['agent_sessions','run_id','runs'],
  ['context_graph_snapshots','graph_id','context_graphs'],['context_nodes','snapshot_id','context_graph_snapshots'],
  ['context_edges','snapshot_id','context_graph_snapshots'],['test_case_revisions','document_id','test_cases'],
  ['test_asset_revisions','document_id','test_assets'],['test_execution_results','execution_id','test_executions'],
  ['intake_items','batch_id','intake_batches'],['intake_attempts','batch_id','intake_batches'],
  ['requirement_document_reviews','document_revision_id','requirement_document_revisions'],
  ['requirement_document_review_votes','review_id','requirement_document_reviews'],['requirement_topic_entry_images','entry_id','requirement_topic_entries'],
] as const) {
  projectScopes[table] = `SELECT DISTINCT s.${['requirement_topic_ideas','requirement_topic_documents','design_prototype_requirements','requirement_baseline_items','task_dependencies','requirement_document_review_votes'].includes(table) ? column : 'id'} AS id,p.project_id FROM ${table} s JOIN (${projectScopes[target]}) p ON p.id=s.${column}`;
}
// The single memory outbox owns exactly one of the two native source kinds.
projectScopes.memory_projection_jobs = `SELECT j.id,coalesce(f.project_id,d.project_id) AS project_id FROM memory_projection_jobs j
  LEFT JOIN (${projectScopes.memory_fragments}) f ON f.id=j.fragment_id
  LEFT JOIN (${projectScopes.project_document_revisions}) d ON d.id=j.project_document_revision_id`;
for (const [table,fields] of Object.entries(parents)) for (const field of fields.split(' ').filter(Boolean)) {
  const [column='',target=''] = field.split(':');
  if (!projectScopes[table] || !projectScopes[target]) continue;
  scopeRules.push(rule(`${table}.${column}.project_scope`, `SELECT count(*)::text AS count FROM ${table} s JOIN (${projectScopes[table]}) l ON l.id=s.${({requirement_topic_ideas:'topic_id',requirement_topic_documents:'topic_id',design_prototype_requirements:'prototype_id',requirement_baseline_items:'baseline_id',task_dependencies:'task_id',requirement_document_review_votes:'review_id'} as Record<string,string>)[table] ?? 'id'} JOIN (${projectScopes[target]}) r ON r.id=s.${column} WHERE l.project_id IS NOT NULL AND r.project_id IS NOT NULL AND l.project_id<>r.project_id`, `${table}.${column}`));
}

for (const [kind,target] of Object.entries(auditTypes)) if (projectScopes[target]) {
  scopeRules.push(rule(`audit_events.entity_id.${kind}.run_project`, `SELECT count(*)::text AS count FROM audit_events s JOIN (${runProject}) l ON l.id=s.run_id JOIN (${projectScopes[target]}) r ON r.id=s.entity_id WHERE s.entity_type='${kind}' AND l.project_id IS NOT NULL AND r.project_id IS NOT NULL AND l.project_id<>r.project_id`, 'audit_events.entity_id', 'audit_events.run_id'));
}
export const INTEGRITY_RELATIONS: readonly IntegrityRule[] = Object.freeze([...ordinary, ...polymorphic, ...scopeRules]);
export const INTEGRITY_EXCEPTIONS = Object.freeze([
  'Nullable references are allowed and do not count as missing parents.',
  'Requirements may have multiple optional structural parents; only present pairs must agree on project.',
  'Project members and owners may be external to a team; membership is not inferred from principal references.',
  'Audit entity_id is checked only through the explicit entity_type catalog; null historical entity_id is allowed and unknown non-null types are reported.',
  'Text codes and immutable JSON snapshots/manifests are not bigint entity references and are not guessed or rewritten.',
]);

/** One bounded, read-only, repeatable-read snapshot. No caller-provided SQL or identifiers. */
export async function checkDatabaseIntegrity(db: Pick<Db, '$client'>) {
  const started = performance.now();
  const { relations, total } = await withReadOnlySnapshot(db, async client => {
    const query = INTEGRITY_RELATIONS.map(check => `SELECT '${check.name}' AS name, q.count FROM (${check.query}) q`).join('\nUNION ALL\n');
    const rows = await client.query<{ name: string; count: string }>(query);
    const relations = rows.rows.map(row => ({ name: row.name, count: Number(row.count) }));
    const total = relations.reduce((total, row) => total + row.count, 0);
    if (!Number.isSafeInteger(total) || relations.some(row => !Number.isSafeInteger(row.count) || row.count < 0)) throw new Error('Invalid integrity count');
    return { relations, total };
  });
  return { checked_at: new Date().toISOString(), duration_ms: Math.round(performance.now() - started), relations, total_orphans: total };
}
