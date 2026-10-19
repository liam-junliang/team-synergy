import { t, getLocale } from './i18n.ts';
import { ApiError } from './apiError.ts';
import { webClientIdentity } from './clientIdentity';

/**
 * core-api 客户端（看板数据源）：任务列表/详情/审计流、成员。
 * envelope：{ ok: true, data } 或 { ok: false, error }。
 */

import { projectCreatePayload, projectUpdatePayload, supportsProjectMemberManagement } from './projectManagement';

export interface TaskSummary {
  code: string;
  feature_code: string;
  requirement_code?: string | null;
  requirement_baseline_code?: string | null;
  requirement_baseline_name?: string | null;
  requirement_baseline_version?: number | null;
  defect_code?: string | null;
  title: string;
  brief: string | null;
  profile: 'planner' | 'builder' | 'verifier';
  source: 'requirement' | 'ad-hoc' | 'defect-fix' | 'integration';
  status: string;
  assignee_code: string | null;
  acceptance: Array<{ id: string; text: string }>;
  base_snapshot: number;
  created_at?: string;
  completed_at?: string | null;
  cancelled_at?: string | null;
}

export interface TaskRun {
  run_code: string;
  workspace_code: string;
  workspace_path: string;
  git_base: string;
  status: string;
  profile: string;
  principal_code: string;
  base_snapshot: number;
  started_at: string;
  finished_at: string | null;
}

export interface TaskHandover {
  handover_code: string;
  task_code: string;
  requirement_baseline_code?: string | null;
  requirement_baseline_name?: string | null;
  requirement_baseline_version?: number | null;
  status: string;
  version: number;
  source_run_code: string;
  source_user_code: string;
  target_user_code: string;
  context_snapshot_code?: string | null;
  summary?: string | Record<string, unknown> | null;
  workspace_manifest?: Record<string, unknown> | null;
  context_snapshot_hash?: string | null;
  can_publish?: boolean;
  can_accept?: boolean;
  can_cancel?: boolean;
  can_approve_drift?: boolean;
  stop_ack?: Record<string, unknown> | null;
}

export interface ProjectHandover extends TaskHandover {
  task_title: string;
  task_status: string;
  source_user_name?: string;
  target_user_name?: string;
  updated_at?: string;
}

export function listProjectHandovers(projectCode: string): Promise<ProjectHandover[]> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/handovers`);
}

export function approveHandoverDrift(handoverCode: string, reason: string): Promise<TaskHandover> {
  return fetchEnvelope(`/handovers/${encodeURIComponent(handoverCode)}/approve-drift`, {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ reason }),
  });
}

export function listTaskHandovers(taskCode: string): Promise<TaskHandover[]> {
  return fetchEnvelope(`/tasks/${encodeURIComponent(taskCode)}/handovers`);
}

export function getHandover(handoverCode: string): Promise<TaskHandover> {
  return fetchEnvelope(`/handovers/${encodeURIComponent(handoverCode)}`);
}

export function getHandoverContext(snapshotCode: string): Promise<Record<string, unknown>> {
  return fetchEnvelope(`/context-snapshots/${encodeURIComponent(snapshotCode)}`);
}

export function diffHandoverContext(snapshotCode: string): Promise<Record<string, unknown>> {
  return fetchEnvelope(`/context-snapshots/${encodeURIComponent(snapshotCode)}/diff`);
}

export function transitionHandover(handoverCode: string, action: 'publish' | 'accept' | 'cancel', version?: number): Promise<TaskHandover> {
  return fetchEnvelope(`/handovers/${encodeURIComponent(handoverCode)}/${action}`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(version === undefined ? {} : { version }),
  });
}

export interface TaskEvidence {
  evidence_code: string;
  run_code: string | null;
  type: string;
  acceptance_refs: string[];
  result: string;
  command: string | null;
  summary: string | null;
  report_uri: string | null;
  recorded_at: string;
}

export interface TaskArtifact {
  artifact_code: string;
  project_code: string;
  run_code: string | null;
  kind: string;
  title: string | null;
  summary: string | null;
  uri: string;
  content_hash: string;
  published: boolean;
  published_at: string | null;
}

export interface AuditEvent {
  timestamp: string;
  action: string;
  principal_code: string | null;
  run_code: string | null;
  from: string | null;
  to: string | null;
  base_snapshot: number;
}

export interface TaskDetail extends TaskSummary {
  source_requirement_revision: number | null;
  project_code: string;
  project_document_code: string | null;
  requirement_document_code: string | null;
  requirement_title: string | null;
  requirement_body: string | null;
  requirement_acceptance_criteria: Array<{ id: string; text: string }>;
  requirement_open_questions: string[];
  defect_code: string | null;
  derived_view: string;
  assignee_principal_code: string | null;
  validation_seams: string[];
  scope: { writable_paths: string[] } | null;
  runs: TaskRun[];
  evidences: TaskEvidence[];
  artifacts: TaskArtifact[];
  evidence_count: number;
  artifact_count: number;
}

export type ProjectMemberRole = 'owner' | 'admin' | 'member' | 'viewer';
export type TeamMemberRole = 'owner' | 'admin' | 'member';
export type ProjectMemberPolicy = 'private' | 'team_read' | 'team_write';
export type ProjectAccessSource = 'owner' | 'explicit' | 'team';
export interface AccessCapabilities {
  read: boolean; write: boolean; manage: boolean; manage_members: boolean;
  manage_admins: boolean; manage_policy: boolean; transfer: boolean; archive: boolean;
}

export interface Member {
  code: string;
  account?: string;
  role: string;
  display_name: string;
  effective_role?: ProjectMemberRole;
  access_source?: ProjectAccessSource;
  is_external?: boolean;
}

export interface ProjectSummary {
  code: string;
  team_code: string;
  team_name?: string;
  is_external?: boolean;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  created_at?: string;
  members_count?: number;
  role: string;
  effective_role?: ProjectMemberRole;
  access_source?: ProjectAccessSource;
  capabilities?: AccessCapabilities;
  owner_code?: string | null;
  created_by_code?: string | null;
  ownership_pending?: boolean;
  member_policy?: ProjectMemberPolicy;
  member_management_supported: boolean;
}

export type ProjectHomeSlot = 'overview' | 'guide';

export interface ProjectHomeDocument {
  document_code: string;
  title: string;
  summary: string;
  content: string;
  revision: number;
  updated_at: string;
}

export interface ProjectHome {
  project_code: string;
  can_edit: boolean;
  overview: ProjectHomeDocument | null;
  guide: ProjectHomeDocument | null;
  standards: ProjectHomeDocument[];
  standards_folder_code: string;
}

export interface UpdateProjectHomeInput {
  overview_document_code?: string | null;
  guide_document_code?: string | null;
}

export interface CreateProjectInput {
  team_code: string;
  name: string;
  description?: string;
  member_policy?: ProjectMemberPolicy;
}

export interface UpdateProjectInput {
  name: string;
  description: string | null;
}

export interface ProjectRepository {
  code: string;
  project_code: string;
  name: string;
  purpose: string | null;
  remote_url: string;
  default_branch: string | null;
  status: 'active' | 'archived';
  can_manage: boolean;
  created_at: string;
  updated_at: string;
}

export interface SaveProjectRepositoryInput {
  name: string;
  purpose: string | null;
  remote_url: string;
  default_branch: string | null;
  status?: 'active' | 'archived';
}

export interface ProjectModule {
  code: string;
  project_code: string;
  name: string;
  summary: string | null;
  status: string;
  order: number;
}

export interface ProjectPhase {
  code: string;
  project_code: string;
  name: string;
  summary: string | null;
  status: string;
  order: number;
  start_at: string | null;
  end_at: string | null;
}

export interface ProjectMilestone {
  code: string;
  project_code: string;
  phase_code: string | null;
  phase_name: string | null;
  name: string;
  summary: string | null;
  status: string;
  order: number;
  start_at: string | null;
  target_at: string | null;
}

export interface AddProjectMemberInput {
  user_code?: string;
  role: Exclude<ProjectMemberRole, 'owner'>;
}

export interface AddTeamMemberInput { user_code?: string; role: Exclude<TeamMemberRole, 'owner'> }

interface RawProjectSummary {
  code?: string;
  project_code?: string;
  id?: string;
  project_id?: string;
  team_code?: string;
  team_id?: string;
  team_name?: string;
  is_external?: boolean;
  name: string;
  description?: string | null;
  status?: 'active' | 'archived';
  created_at?: string;
  members_count?: number;
  role: string;
  effective_role?: ProjectMemberRole;
  access_source?: ProjectAccessSource;
  capabilities?: AccessCapabilities;
  owner_code?: string | null;
  created_by_code?: string | null;
  ownership_pending?: boolean;
  member_policy?: ProjectMemberPolicy;
}

type RawAuthUser = Partial<AuthUser> & { code?: string; user_code?: string; user_id?: string };
type RawMember = Partial<Member> & { code?: string; user_code?: string; principal_code?: string; principal_id?: string };
type RawTeamSummary = Partial<TeamSummary> & { code?: string; team_code?: string; team_id?: string };
type RawFeature = Partial<Feature> & { code?: string; feature_code?: string; feature_id?: string; project_code?: string; project_id?: string; sort_order?: number; start_date?: string | null; end_date?: string | null };
type RawRequirement = Partial<Requirement> & {
  code?: string;
  requirement_code?: string;
  requirement_id?: string;
  feature_code?: string | null;
  feature_id?: string;
  module_code?: string | null;
  module_id?: string | null;
  module_name?: string | null;
  document_code?: string | null;
  document_id?: string | null;
  owner_code?: string;
  owner_principal_code?: string;
  owner_principal_id?: string;
};
type RawProjectModule = Partial<ProjectModule> & {
  code?: string;
  module_code?: string;
  module_id?: string;
  project_code?: string;
  project_id?: string;
  title?: string;
  goal?: string | null;
  description?: string | null;
  sort_order?: number;
};
type RawProjectPhase = Partial<ProjectPhase> & {
  code?: string;
  phase_code?: string;
  phase_id?: string;
  project_code?: string;
  project_id?: string;
  title?: string;
  goal?: string | null;
  sort_order?: number;
  start_date?: string | null;
  end_date?: string | null;
};
type RawProjectMilestone = Partial<ProjectMilestone> & {
  code?: string;
  milestone_code?: string;
  milestone_id?: string;
  project_code?: string;
  project_id?: string;
  phase_code?: string | null;
  phase_id?: string | null;
  phase_name?: string | null;
  title?: string;
  goal?: string | null;
  sort_order?: number;
  start_date?: string | null;
  target_date?: string | null;
};
type RawRequirementDocumentSummary = Partial<RequirementDocumentSummary> & {
  code?: string;
  document_code?: string;
  document_id?: string;
  project_code?: string;
  project_id?: string;
  owner_code?: string;
  owner_principal_code?: string;
  owner_principal_id?: string;
};
type RawRequirementDocumentDetail = RawRequirementDocumentSummary & {
  code?: string;
  document_code?: string;
  document_id?: string;
  project_code?: string;
  project_id?: string;
  owner_code?: string;
  owner_principal_code?: string;
  owner_principal_id?: string;
  content: string;
  change_summary: string;
  outline: Array<{ level: number; title: string; anchor: string }>;
  revisions: Array<{
    revision: number;
    summary: string;
    content: string;
    keywords: string[];
    change_summary: string;
    created_by: string;
    created_at: string;
  }>;
  linked_requirements: Array<{
    requirement_code?: string;
    requirement_id?: string;
    title: string;
    state: RequirementStatus;
    current_revision: number;
  }>;
  can_edit: boolean;
};
type RawDesignPrototypeSummary = Partial<DesignPrototypeSummary> & {
  code?: string;
  prototype_code?: string;
  prototype_id?: string;
  project_code?: string;
  project_id?: string;
  owner_code?: string;
  owner_principal_code?: string;
  owner_principal_id?: string;
};
type RawDesignPrototypeDetail = RawDesignPrototypeSummary & {
  html_content?: string;
  notes_markdown?: string;
  change_summary?: string;
  revisions?: Array<Partial<DesignPrototypeContent> & {
    revision_code?: string;
    revision_id?: string;
    revision: number;
    change_summary: string;
    has_notes?: boolean;
    created_by_user_code?: string;
    created_by?: string;
    created_at: string;
  }>;
  can_edit?: boolean;
};
type RawTaskSummary = Partial<TaskSummary> & {
  code?: string;
  task_code?: string;
  task_id?: string;
  feature_code?: string;
  feature_id?: string;
  requirement_code?: string | null;
  requirement_id?: string | null;
  defect_code?: string | null;
  defect_id?: string | null;
  brief?: string | null;
  assignee_code?: string | null;
  assignee_principal_code?: string | null;
  assignee_principal_id?: string | null;
};
type RawTaskRun = Partial<TaskRun> & {
  run_code?: string;
  run_id?: string;
  workspace_code?: string;
  workspace_id?: string;
  workspace_path?: string;
  git_base?: string;
  principal_code?: string;
  principal_id?: string;
  finished_at?: string | null;
};
type RawTaskEvidence = Partial<TaskEvidence> & {
  evidence_code?: string;
  evidence_id?: string;
  run_code?: string | null;
  run_id?: string | null;
  report_uri?: string | null;
};
type RawTaskArtifact = Partial<TaskArtifact> & {
  artifact_code?: string;
  artifact_id?: string;
  project_code?: string;
  project_id?: string;
  run_code?: string | null;
  run_id?: string | null;
};
type RawTaskStatus = RawTaskSummary & {
  source_requirement_revision?: number | null;
  project_code?: string;
  project_id?: string;
  project_document_code?: string | null;
  requirement_document_code?: string | null;
  requirement_title?: string | null;
  requirement_body?: string | null;
  requirement_acceptance_criteria?: Array<{ id: string; text: string }>;
  requirement_open_questions?: string[];
  defect_code?: string | null;
  derived_view?: string;
  validation_seams?: string[];
  scope?: { writable_paths: string[] } | null;
  runs?: RawTaskRun[];
  evidences?: RawTaskEvidence[];
  artifacts?: RawTaskArtifact[];
  evidence_count?: number;
  artifact_count?: number;
};
type RawAuditEvent = Partial<AuditEvent> & { principal_code?: string | null; principal_id?: string | null; run_code?: string | null; run_id?: string | null };
type RawTaskGraph = {
  nodes: Array<{ code?: string; task_code?: string; task_id?: string; title?: string; status?: string }>;
  edges: Array<{ from: string; to: string }>;
};
type RawDefectSummary = Partial<DefectSummary> & {
  code?: string;
  defect_code?: string;
  defect_id?: string;
  feature_code?: string;
  feature_id?: string;
  reported_by_user_code?: string;
  related_requirement_code?: string | null;
  related_requirement?: string | null;
};
type RawEvidence = Partial<Evidence> & { code?: string; evidence_code?: string; evidence_id?: string; task_code?: string; task_id?: string; run_code?: string; run_id?: string | null };
type RawUserAccount = Partial<UserAccount> & { code?: string; user_code?: string; user_id?: string };
type RawUserDirectoryEntry = Partial<UserDirectoryEntry> & { code?: string; user_code?: string; user_id?: string };
type RawDeviceSummary = Partial<DeviceSummary> & { code?: string; device_code?: string; device_id?: string };
type RawProjectArtifact = Partial<ProjectArtifact> & {
  code?: string;
  artifact_code?: string;
  artifact_id?: string;
  project_code?: string;
  project_id?: string;
  task_code?: string | null;
  task_id?: string | null;
};
type RawProjectDocument = Partial<ProjectDocument> & { project_code?: string; project_id?: string };
type RawCreateUserResult = { code?: string; user_code?: string; user_id?: string; account: string; initial_password: string; expires_at: string };
type RawBindTokenResult = { code?: string; user_code?: string; user_id?: string; account: string; bind_token: string; expires_at: string };

export interface TeamSummary {
  code: string;
  name: string;
  role: TeamMemberRole;
  owner_code?: string | null;
  created_by_code?: string | null;
  ownership_pending?: boolean;
  capabilities?: AccessCapabilities;
  members_count: number;
  projects_count: number;
  created_at: string;
}

export interface CreateTeamInput {
  name: string;
}

export type RenameTeamResult = TeamSummary;

export interface ProjectArtifact {
  code: string;
  project_code: string;
  task_code: string | null;
  kind: 'commit' | 'document' | 'prototype' | 'report' | 'other';
  title: string | null;
  summary: string | null;
  uri: string;
  content_hash: string;
  published: boolean;
  published_at: string | null;
}

export interface ProjectDocument {
  project_code: string;
  title: string;
  content: string;
  revision: number;
  updated_by: string | null;
  updated_at: string | null;
  can_edit: boolean;
}

export type HandoffDocumentKind = 'doc' | 'api' | 'diagram';
export type LegacyHandoffDocumentKind = 'general' | 'integration' | 'deployment' | 'data' | 'operations' | 'release';
export type ArchitectureContentKind = 'mermaid' | 'drawio' | 'image';

export interface ArchitectureDocumentSummary {
  document_code: string;
  project_code: string;
  title: string;
  summary: string;
  content_kind: ArchitectureContentKind;
  current_revision: number;
  owner_principal_code: string;
  updated_at: string;
  can_edit: boolean;
}

export interface ArchitectureDocumentRevision {
  revision_code: string;
  revision: number;
  title: string;
  summary: string;
  content_kind: ArchitectureContentKind;
  source_content: string;
  notes_markdown: string;
  preview_svg: string | null;
  change_summary: string;
  created_by_user_code: string | null;
  created_at: string;
}

export interface ArchitectureDocumentDetail extends ArchitectureDocumentSummary {
  source_content: string;
  notes_markdown: string;
  preview_svg: string | null;
  revisions: ArchitectureDocumentRevision[];
}

export interface ArchitectureDocumentInput {
  title: string;
  summary?: string;
  content_kind: ArchitectureContentKind;
  source_content: string;
  notes_markdown?: string;
  preview_svg?: string | null;
  change_summary?: string;
}

export interface ArchitectureDocumentRevisionInput extends ArchitectureDocumentInput {
  base_revision: number;
  change_summary: string;
}
export type HandoffDocumentStatus = 'active' | 'archived';

export interface HandoffFolder {
  folder_code: string;
  parent_folder_code: string | null;
  name: string;
  sort_order: number;
  status: HandoffDocumentStatus;
  system_role: 'standards' | 'requirements' | 'architecture' | 'testing' | null;
  can_create_folder?: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

export interface HandoffDocumentSummary {
  document_code: string;
  source_kind?: 'project' | 'requirement' | 'architecture' | 'testing';
  source_can_edit?: boolean;
  folder_code: string | null;
  folder_name: string | null;
  kind: HandoffDocumentKind | LegacyHandoffDocumentKind;
  legacy_kind?: LegacyHandoffDocumentKind | null;
  title: string;
  summary: string;
  current_revision: number;
  status: HandoffDocumentStatus;
  updated_by_user_code: string | null;
  updated_at: string;
  can_edit: boolean;
}

export interface HandoffDocumentRevision {
  revision_code: string;
  revision: number;
  title: string;
  summary: string | null;
  content: string;
  change_summary: string;
  created_by_user_code: string;
  created_at: string;
}

export interface HandoffDocumentDetail extends HandoffDocumentSummary {
  project_code: string;
  content: string;
  outline: Array<{ level: number; title: string; anchor: string }>;
  revisions: HandoffDocumentRevision[];
  architecture_document?: ArchitectureDocumentDetail;
  testing_asset?: TestAssetDetail;
}

export interface HandoffLibrary {
  project_code: string;
  can_create: boolean;
  folders: HandoffFolder[];
  documents: HandoffDocumentSummary[];
}

export interface HandoffDocumentInput {
  folder_code?: string | null;
  kind?: HandoffDocumentKind;
  title: string;
  summary?: string;
  content: string;
  change_summary?: string;
  status?: HandoffDocumentStatus;
}

export interface CreateProjectArtifactInput {
  kind: 'document' | 'prototype' | 'report' | 'other';
  title: string;
  summary?: string;
  uri: string;
  content_hash?: string;
}

export interface DefectSummary {
  code: string;
  feature_code: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: string;
  reported_by: string;
  description: string;
  found_in: string | null;
  related_requirement_code: string | null;
  reported_at: string | null;
  fix_tasks: Array<{
    task_code: string;
    title: string;
    status: string;
    assignee_principal_code: string | null;
    created_at: string;
  }>;
}

export interface CreateDefectInput {
  feature_code: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  found_in?: string;
  related_requirement_code?: string;
}

export interface Feature {
  code: string;
  project_code: string;
  title: string;
  goal: string | null;
  status: string;
  order: number;
  module_code: string | null;
  module_name: string | null;
  milestone_code: string | null;
  milestone_name: string | null;
  start_at: string | null;
  end_at: string | null;
}

export type RequirementStatus = 'draft' | 'clarifying' | 'confirmed' | 'implementing' | 'delivered' | 'change_proposed' | 'deprecated';

export interface RequirementAcceptanceCriterion {
  id: string;
  text: string;
}

export interface Requirement {
  code: string;
  feature_code: string | null;
  module_code: string | null;
  module_name: string | null;
  document_code: string | null;
  title: string;
  current_revision: number;
  owner_code: string;
  status: RequirementStatus;
  body: string;
  acceptance_criteria: RequirementAcceptanceCriterion[];
  open_questions: string[];
  revision_created_at: string | null;
  task_count?: number;
}

export interface RequirementTask {
  task_code: string;
  title: string;
  status: string;
  profile: string;
  assignee_code: string | null;
}

export interface RequirementDetail extends Requirement {
  tasks: RequirementTask[];
  revisions: Array<{
    revision: number;
    body: string;
    acceptance_criteria: RequirementAcceptanceCriterion[];
    open_questions: string[];
    created_at: string;
  }>;
  can_edit: boolean;
  available_transitions: RequirementStatus[];
}

export interface RequirementBaselineItem {
  requirement_code: string;
  revision: number;
  revision_code: string;
  title: string;
  status: string;
  feature_code: string | null;
  module_code: string | null;
  document_code: string | null;
  body: string;
  acceptance_criteria: RequirementAcceptanceCriterion[];
  open_questions: string[];
}

export interface RequirementBaseline {
  baseline_code: string;
  project_code: string;
  version: number;
  name: string;
  scope: string;
  reason: string;
  parent_baseline_code: string | null;
  created_by: string;
  created_at: string;
  content_hash: string;
  requirements: RequirementBaselineItem[];
}

export interface RequirementBaselineDiff {
  from_baseline_code: string;
  to_baseline_code: string | null;
  changes: Array<{ requirement_code: string; kind: 'added' | 'modified' | 'removed'; before: RequirementBaselineItem | null; after: RequirementBaselineItem | null; changed_fields: string[] }>;
  counts: { added: number; modified: number; removed: number };
}

export interface CreateRequirementBaselineInput {
  name: string;
  scope: string;
  reason: string;
  parent_baseline_code?: string | null;
  requirements: Array<{ requirement_code: string; revision: number }>;
}

export interface RequirementBaselineBindings {
  tasks: Array<{ task_code: string; title: string; status: string; baseline_code: string | null; baseline_version: number | null }>;
  handovers: Array<{ handover_code: string; task_code: string; task_title: string; status: string; baseline_code: string | null; baseline_version: number | null }>;
}

export function listRequirementBaselineBindings(projectCode: string): Promise<RequirementBaselineBindings> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/requirement-baselines/bindings`);
}

export function listRequirementBaselines(projectCode: string): Promise<{ baselines: RequirementBaseline[]; can_create: boolean }> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/requirement-baselines`);
}
export function getRequirementBaseline(projectCode: string, code: string): Promise<RequirementBaseline> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/requirement-baselines/${encodeURIComponent(code)}`);
}
export function createRequirementBaseline(projectCode: string, input: CreateRequirementBaselineInput): Promise<RequirementBaseline> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/requirement-baselines`, { method: 'POST', body: JSON.stringify(input) });
}
export function compareRequirementBaseline(projectCode: string, code: string, compareTo = 'current'): Promise<RequirementBaselineDiff> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/requirement-baselines/${encodeURIComponent(code)}/diff?compare_to=${encodeURIComponent(compareTo)}`);
}
export function bindTaskBaseline(taskCode: string, baselineCode: string, baseSnapshot: number): Promise<unknown> {
  return fetchEnvelope(`/tasks/${encodeURIComponent(taskCode)}/baseline`, { method: 'POST', body: JSON.stringify({ baseline_code: baselineCode, base_snapshot: baseSnapshot }) });
}

export interface CreateRequirementInput {
  feature_code?: string | null;
  module_code?: string | null;
  module_name?: string | null;
  document_code?: string;
  title: string;
  body: string;
  acceptance_criteria: RequirementAcceptanceCriterion[];
  open_questions: string[];
  status?: 'draft';
}

export interface CreateFeatureInput {
  project_code: string;
  title: string;
  goal?: string;
  status?: string;
  order?: number;
  module_code?: string | null;
  module_name?: string | null;
  milestone_code?: string | null;
  milestone_name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface UpdateFeatureInput {
  title?: string;
  goal?: string | null;
  status?: string;
  order?: number;
  module_code?: string | null;
  module_name?: string | null;
  milestone_code?: string | null;
  milestone_name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface CreateProjectModuleInput {
  name: string;
  summary?: string;
  order?: number;
}

export interface UpdateProjectModuleInput {
  name?: string;
  summary?: string;
  status?: string;
  order?: number;
}

export interface CreateProjectPhaseInput {
  name: string;
  summary?: string;
  order?: number;
  status?: string;
  start_at?: string | null;
  end_at?: string | null;
}

export interface UpdateProjectPhaseInput {
  name?: string;
  summary?: string;
  status?: string;
  order?: number;
  start_at?: string | null;
  end_at?: string | null;
}

export interface CreateProjectMilestoneInput {
  name: string;
  summary?: string;
  phase_code?: string | null;
  phase_name?: string | null;
  order?: number;
  status?: string;
  start_at?: string | null;
  target_at?: string | null;
}

export interface UpdateProjectMilestoneInput {
  name?: string;
  summary?: string;
  phase_code?: string | null;
  phase_name?: string | null;
  status?: string;
  order?: number;
  start_at?: string | null;
  target_at?: string | null;
}

export interface UpdateRequirementInput {
  title: string;
  body: string;
  acceptance_criteria: RequirementAcceptanceCriterion[];
  open_questions: string[];
}

export type RequirementDocumentStatus = 'active' | 'archived';

export interface RequirementDocumentSummary {
  code: string;
  project_code: string;
  module_key: string;
  title: string;
  state: RequirementDocumentStatus;
  current_revision: number;
  owner_code: string;
  summary: string;
  keywords: string[];
  updated_at: string;
}

export interface RequirementDocumentDetail extends RequirementDocumentSummary {
  content: string;
  change_summary: string;
  outline: Array<{ level: number; title: string; anchor: string }>;
  revisions: Array<{
    revision: number;
    summary: string;
    content: string;
    keywords: string[];
    change_summary: string;
    created_by: string;
    created_at: string;
  }>;
  linked_requirements: Array<{
    requirement_code: string;
    title: string;
    state: RequirementStatus;
    current_revision: number;
  }>;
  can_edit: boolean;
}

export interface RequirementDocumentInput {
  module_code?: string;
  module_key: string;
  title: string;
  summary: string;
  content: string;
  keywords: string[];
  change_summary?: string;
}

export type RequirementIdeaStatus = 'active' | 'archived';
export interface RequirementIdea {
  idea_code: string;
  title: string;
  detail: string;
  source: string | null;
  status: RequirementIdeaStatus;
  created_by: string | null;
  created_by_name: string | null;
  topic_count: number;
  created_at: string;
  updated_at: string;
}

export type RequirementTopicStatus = 'open' | 'decided' | 'reopened' | 'archived';
export type RequirementTopicEntryType = 'comment' | 'alternative' | 'feedback' | 'decision';
export interface RequirementTopicEntryImage {
  image_code: string;
  file_name: string;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  byte_size: number;
  data_url: string;
}
export interface RequirementTopicEntryImageInput {
  file_name: string;
  data_url: string;
}
export interface RequirementTopicSummary {
  topic_code: string;
  title: string;
  problem_statement: string;
  goal: string;
  status: RequirementTopicStatus;
  idea_count: number;
  document_count: number;
  entry_count: number;
  current_decision: { entry_code: string; content: string; rationale: string | null; created_at: string } | null;
  created_at: string;
  updated_at: string;
}
export interface RequirementTopicEntry {
  entry_code: string;
  entry_type: RequirementTopicEntryType;
  content: string;
  rationale: string | null;
  supersedes_entry_code: string | null;
  source_entity_type: string | null;
  source_entity_code: string | null;
  author_code: string | null;
  author_name: string | null;
  images: RequirementTopicEntryImage[];
  withdrawn_at: string | null;
  withdrawn_by_code: string | null;
  withdrawn_by_name: string | null;
  withdrawal_reason: string | null;
  can_withdraw: boolean;
  created_at: string;
}
export interface RequirementTopicDetail extends RequirementTopicSummary {
  ideas: RequirementIdea[];
  documents: Array<{ document_code: string; title: string; current_revision: number; state: RequirementDocumentStatus }>;
  entries: RequirementTopicEntry[];
  can_manage: boolean;
}

export type RequirementReviewVote = 'support' | 'changes_requested' | 'abstain';
export interface RequirementDocumentReview {
  review_code: string;
  document_code: string;
  document_title: string;
  revision_code: string;
  revision: number;
  status: 'open' | 'closed' | 'cancelled';
  conclusion: 'passed' | 'changes_requested' | 'no_consensus' | null;
  requested_by: string | null;
  requested_by_name: string | null;
  opened_at: string;
  closed_at: string | null;
  votes: Array<{ principal_code: string | null; principal_name: string | null; vote: RequirementReviewVote; comment: string; responded_at: string }>;
}

export type DesignPrototypeStatus = 'draft' | 'ready' | 'archived';
export type DesignPrototypeKind = 'html' | 'image' | 'url' | 'file';

export interface DesignPrototypeContent {
  content_kind: DesignPrototypeKind;
  external_url: string | null;
  file_name: string | null;
  file_mime_type: string | null;
  file_size: number | null;
  file_sha256: string | null;
  download_path: string | null;
}

export interface DesignPrototypeRequirementLink {
  requirement_code: string;
  title: string;
  status: string;
  feature_code: string | null;
  feature_name: string | null;
}

export interface DesignPrototypeSummary extends DesignPrototypeContent {
  code: string;
  project_code: string;
  title: string;
  summary: string;
  status: DesignPrototypeStatus;
  current_revision: number;
  owner_code: string;
  linked_requirements: DesignPrototypeRequirementLink[];
  updated_at: string;
}

export interface DesignPrototypeDetail extends DesignPrototypeSummary {
  html_content: string;
  notes_markdown: string;
  change_summary: string;
  revisions: Array<DesignPrototypeContent & {
    code: string;
    revision: number;
    change_summary: string;
    has_notes: boolean;
    created_by: string;
    created_at: string;
  }>;
  can_edit: boolean;
}

export interface DesignPrototypeInput {
  title: string;
  summary: string;
  html_content: string;
  content_kind?: DesignPrototypeKind;
  external_url?: string;
  file_name?: string;
  file_mime_type?: string;
  file_content_base64?: string;
  notes_markdown: string;
  requirement_codes: string[];
  status: Exclude<DesignPrototypeStatus, 'archived'> | DesignPrototypeStatus;
  change_summary?: string;
}

export interface CreateTaskInput {
  feature_code: string;
  requirement_code?: string;
  defect_code?: string;
  title: string;
  brief?: string;
  profile: 'planner' | 'builder' | 'verifier';
  source: 'requirement' | 'ad-hoc' | 'defect-fix' | 'integration';
  acceptance: RequirementAcceptanceCriterion[];
}

export interface TaskGraph {
  nodes: Array<{ code: string; title: string; status: string }>;
  edges: Array<{ from: string; to: string }>;
}

export interface Evidence {
  code: string;
  task_code: string;
  run_code: string | null;
  type: 'self_test' | 'verifier_review' | 'deployment' | 'manual';
  acceptance_refs: string[];
  result: 'pass' | 'fail' | 'inconclusive';
  command: string | null;
  summary: string | null;
  report_uri: string | null;
  recorded_at: string;
}

export interface AuthUser {
  code: string;
  account: string;
  display_name: string;
  status: 'active';
  is_system_admin: boolean;
  must_change_password: boolean;
}

interface WebLoginResult {
  device_code: string;
  device_token: string;
  user_code: string;
  device_name: string;
}

const AUTH_TOKEN_KEY = 'acp.device_token';
const AUTH_USER_KEY = 'acp.auth_user';

function authToken(): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(AUTH_TOKEN_KEY);
}

export function storedAuthUser(): AuthUser | null {
  if (typeof window === 'undefined' || !authToken()) return null;
  const raw = window.localStorage.getItem(AUTH_USER_KEY);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as Partial<AuthUser>;
    return typeof user.account === 'string' && typeof user.display_name === 'string'
      && typeof user.is_system_admin === 'boolean' && typeof user.must_change_password === 'boolean' && user.status === 'active'
      ? normalizeAuthUser(user)
      : null;
  } catch {
    return null;
  }
}

export function hasWebAuthToken(): boolean {
  return Boolean(authToken());
}

export function clearWebSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(AUTH_USER_KEY);
}

export async function fetchEnvelope<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = authToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const envelope = body as { ok: boolean; data: T; error?: { code: string; message: string } } | null;
  if (res.status === 401 && envelope?.ok !== true && !path.startsWith('/auth/')) {
    // 未认证/凭据失效：清会话并广播，由 App 回到登录页。
    // /auth/* 路径豁免（password-login 失败返回 401 是正常业务结果，
    // 不应清掉可能仍有效的会话或触发全局登出）。
    clearWebSession();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('acp:auth-expired'));
  }
  if (!res.ok || !envelope?.ok) {
    const detail = envelope?.error;
    throw detail ? new ApiError(detail.code, detail.message, res.status) : new Error(`HTTP ${res.status}: ${path}`);
  }
  return envelope.data;
}

function appendQueryParam(query: string, key: string, value?: string): string {
  if (!value) return query;
  const params = new URLSearchParams(query.replace(/^\?/, ''));
  params.set(key, value);
  return `?${params.toString()}`;
}

function codeFrom(...values: Array<string | null | undefined>): string {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? '';
}

function optionalCode(...values: Array<string | null | undefined>): string | null {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

interface ProjectStructureStore {
  modules: RawProjectModule[];
  phases: RawProjectPhase[];
  milestones: RawProjectMilestone[];
  features: RawFeature[];
}

const EMPTY_PROJECT_STRUCTURE_STORE: ProjectStructureStore = {
  modules: [],
  phases: [],
  milestones: [],
  features: [],
};

function canUseBrowserStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function projectStructureStorageKey(projectCode: string): string {
  return `acp:project-structure:v1:${projectCode}`;
}

function readJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readProjectStructureStore(projectCode: string): ProjectStructureStore {
  if (!canUseBrowserStorage()) return { ...EMPTY_PROJECT_STRUCTURE_STORE };
  const raw = readJson<Partial<ProjectStructureStore>>(window.localStorage.getItem(projectStructureStorageKey(projectCode)), {});
  return {
    modules: Array.isArray(raw.modules) ? raw.modules : [],
    phases: Array.isArray(raw.phases) ? raw.phases : [],
    milestones: Array.isArray(raw.milestones) ? raw.milestones : [],
    features: Array.isArray(raw.features) ? raw.features : [],
  };
}

function writeProjectStructureStore(projectCode: string, updater: (store: ProjectStructureStore) => ProjectStructureStore): ProjectStructureStore {
  const nextStore = updater(readProjectStructureStore(projectCode));
  if (canUseBrowserStorage()) {
    window.localStorage.setItem(projectStructureStorageKey(projectCode), JSON.stringify(nextStore));
  }
  return nextStore;
}

function isFallbackRouteError(error: unknown): boolean {
  return error instanceof Error && /^HTTP (404|405|501)\b/.test(error.message);
}

function nextLocalCode(prefix: string, existingCodes: Array<string | null | undefined>): string {
  const highest = existingCodes.reduce((max, code) => {
    const value = code ?? '';
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(value);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`;
}

function mergeFeatureLists(primary: RawFeature[], secondary: RawFeature[]): RawFeature[] {
  const merged = new Map<string, RawFeature>();
  [...primary, ...secondary].forEach((feature) => {
    const code = codeFrom(feature.code, feature.feature_code, feature.feature_id);
    if (!code) return;
    merged.set(code, { ...merged.get(code), ...feature, code });
  });
  return [...merged.values()];
}

function normalizeAndMergeFeatures(primary: RawFeature[], secondary: RawFeature[]): Feature[] {
  return mergeFeatureLists(secondary, primary).map((feature) => normalizeFeature(feature)).sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, getLocale()) || left.code.localeCompare(right.code));
}

function normalizeAndMergeModules(modules: RawProjectModule[], features: Feature[]): ProjectModule[] {
  const derived = new Map<string, ProjectModule>();
  features.forEach((feature) => {
    if (!feature.module_code && !feature.module_name) return;
    const code = feature.module_code ?? feature.module_name ?? '';
    if (!code) return;
    if (!derived.has(code)) {
      derived.set(code, {
        code,
        project_code: feature.project_code,
        name: feature.module_name ?? feature.module_code ?? code,
        summary: null,
        status: 'active',
        order: feature.order,
      });
    }
  });
  const merged = new Map<string, ProjectModule>();
  [...derived.values(), ...modules.map((item) => normalizeProjectModule(item))].forEach((module) => {
    if (!module.code) return;
    merged.set(module.code, module);
  });
  return [...merged.values()].sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, getLocale()) || left.code.localeCompare(right.code));
}

function normalizeProjectModule(module: RawProjectModule): ProjectModule {
  const code = codeFrom(module.code, module.module_code, module.module_id);
  return {
    code,
    project_code: codeFrom(module.project_code, module.project_id),
    name: module.name ?? module.title ?? '',
    summary: module.description ?? module.goal ?? module.summary ?? null,
    status: module.status ?? 'active',
    order: module.sort_order ?? module.order ?? 0,
  };
}

function normalizeProjectPhase(phase: RawProjectPhase): ProjectPhase {
  const code = codeFrom(phase.code, phase.phase_code, phase.phase_id);
  return {
    code,
    project_code: codeFrom(phase.project_code, phase.project_id),
    name: phase.name ?? phase.title ?? '',
    summary: phase.goal ?? phase.summary ?? null,
    status: phase.status ?? 'planned',
    order: phase.sort_order ?? phase.order ?? 0,
    start_at: phase.start_date ?? phase.start_at ?? null,
    end_at: phase.end_date ?? phase.end_at ?? null,
  };
}

function normalizeProjectMilestone(milestone: RawProjectMilestone): ProjectMilestone {
  const code = codeFrom(milestone.code, milestone.milestone_code, milestone.milestone_id);
  return {
    code,
    project_code: codeFrom(milestone.project_code, milestone.project_id),
    phase_code: optionalCode(milestone.phase_code, milestone.phase_id),
    phase_name: milestone.phase_name ?? null,
    name: milestone.name ?? milestone.title ?? '',
    summary: milestone.goal ?? milestone.summary ?? null,
    status: milestone.status ?? 'planned',
    order: milestone.sort_order ?? milestone.order ?? 0,
    start_at: milestone.start_date ?? milestone.start_at ?? null,
    target_at: milestone.target_date ?? milestone.target_at ?? null,
  };
}

function updateStoredFeature(projectCode: string, feature: RawFeature): Feature {
  let storedFeature: Feature | null = null;
  writeProjectStructureStore(projectCode, (store) => {
    const code = codeFrom(feature.code, feature.feature_code, feature.feature_id);
    const nextFeatures = [...store.features.filter((item) => codeFrom(item.code, item.feature_code, item.feature_id) !== code), { ...feature, code }];
    storedFeature = normalizeFeature({ ...feature, code });
    return { ...store, features: nextFeatures };
  });
  return storedFeature ?? normalizeFeature(feature);
}

function updateLocalEntity<T extends { code?: string }>(projectCode: string, collection: keyof ProjectStructureStore, entity: T): T {
  let storedEntity = entity;
  writeProjectStructureStore(projectCode, (store) => {
    const code = codeFrom(entity.code);
    const nextCollection = [...store[collection].filter((item) => codeFrom((item as { code?: string }).code) !== code), { ...entity, code }];
    storedEntity = { ...entity, code } as T;
    return { ...store, [collection]: nextCollection } as ProjectStructureStore;
  });
  return storedEntity;
}

function sortByOrderThenName<T extends { order?: number; name: string; code: string }>(left: T, right: T): number {
  return (left.order ?? 0) - (right.order ?? 0) || left.name.localeCompare(right.name, getLocale()) || left.code.localeCompare(right.code);
}

function normalizeAuthUser(user: RawAuthUser): AuthUser {
  const code = codeFrom(user.code, user.user_code, user.user_id);
  return {
    code,
    account: user.account ?? '',
    display_name: user.display_name ?? '',
    status: 'active',
    is_system_admin: Boolean(user.is_system_admin),
    must_change_password: Boolean(user.must_change_password),
  };
}

function normalizeMember(member: RawMember): Member {
  const code = codeFrom(member.code, member.user_code, member.principal_code, member.principal_id);
  return {
    code,
    ...(member.account ? { account: member.account } : {}),
    role: member.role ?? 'member',
    display_name: member.display_name ?? '',
    ...(member.effective_role ? { effective_role: member.effective_role } : {}),
    ...(member.access_source ? { access_source: member.access_source } : {}),
    ...(typeof member.is_external === 'boolean' ? { is_external: member.is_external } : {}),
  };
}

function normalizeProject(project: RawProjectSummary): ProjectSummary {
  const code = codeFrom(project.code, project.project_code, project.id, project.project_id);
  return {
    code,
    team_code: codeFrom(project.team_code, project.team_id),
    team_name: project.team_name,
    is_external: typeof project.is_external === 'boolean' ? project.is_external : undefined,
    name: project.name,
    description: project.description?.trim() || null,
    status: project.status === 'archived' ? 'archived' : 'active',
    created_at: project.created_at,
    members_count: project.members_count,
    role: project.role,
    effective_role: project.effective_role,
    access_source: project.access_source,
    capabilities: project.capabilities,
    owner_code: project.owner_code,
    created_by_code: project.created_by_code,
    ownership_pending: project.ownership_pending,
    member_policy: project.member_policy,
    member_management_supported: supportsProjectMemberManagement(project),
  };
}

function normalizeTeam(team: RawTeamSummary): TeamSummary {
  const code = codeFrom(team.code, team.team_code, team.team_id);
  return {
    code,
    name: team.name ?? '',
    role: team.role === 'owner' || team.role === 'admin' ? team.role : 'member',
    owner_code: team.owner_code,
    created_by_code: team.created_by_code,
    ownership_pending: team.ownership_pending,
    capabilities: team.capabilities,
    members_count: team.members_count ?? 0,
    projects_count: team.projects_count ?? 0,
    created_at: team.created_at ?? '',
  };
}

function normalizeFeature(feature: RawFeature): Feature {
  const code = codeFrom(feature.code, feature.feature_code, feature.feature_id);
  return {
    code,
    project_code: codeFrom(feature.project_code, feature.project_id),
    title: feature.title ?? '',
    goal: feature.goal ?? null,
    status: feature.status ?? 'draft',
    order: feature.sort_order ?? feature.order ?? 0,
    module_code: optionalCode(feature.module_code),
    module_name: feature.module_name ?? null,
    milestone_code: optionalCode(feature.milestone_code),
    milestone_name: feature.milestone_name ?? null,
    start_at: feature.start_date ?? feature.start_at ?? null,
    end_at: feature.end_date ?? feature.end_at ?? null,
  };
}

function normalizeRequirement(requirement: RawRequirement): Requirement {
  const code = codeFrom(requirement.code, requirement.requirement_code, requirement.requirement_id);
  return {
    code,
    feature_code: optionalCode(requirement.feature_code, requirement.feature_id),
    module_code: optionalCode(requirement.module_code, requirement.module_id),
    module_name: requirement.module_name ?? null,
    document_code: optionalCode(requirement.document_code, requirement.document_id),
    title: requirement.title ?? '',
    current_revision: requirement.current_revision ?? 0,
    owner_code: codeFrom(requirement.owner_code, requirement.owner_principal_code, requirement.owner_principal_id),
    status: requirement.status ?? 'draft',
    body: requirement.body ?? '',
    acceptance_criteria: requirement.acceptance_criteria ?? [],
    open_questions: requirement.open_questions ?? [],
    revision_created_at: requirement.revision_created_at ?? null,
    task_count: requirement.task_count,
  };
}

function normalizeRequirementDocument(document: RawRequirementDocumentSummary): RequirementDocumentSummary {
  const code = codeFrom(document.code, document.document_code, document.document_id);
  return {
    code,
    project_code: codeFrom(document.project_code, document.project_id),
    module_key: document.module_key ?? '',
    title: document.title ?? '',
    state: document.state ?? 'active',
    current_revision: document.current_revision ?? 0,
    owner_code: codeFrom(document.owner_code, document.owner_principal_code, document.owner_principal_id),
    summary: document.summary ?? '',
    keywords: document.keywords ?? [],
    updated_at: document.updated_at ?? '',
  };
}

function normalizeProjectDocument(document: RawProjectDocument): ProjectDocument {
  const projectCode = codeFrom(document.project_code, document.project_id);
  return {
    project_code: projectCode,
    title: document.title ?? '',
    content: document.content ?? '',
    revision: document.revision ?? 0,
    updated_by: document.updated_by ?? null,
    updated_at: document.updated_at ?? null,
    can_edit: Boolean(document.can_edit),
  };
}

function normalizeRequirementDocumentDetail(document: RawRequirementDocumentDetail): RequirementDocumentDetail {
  return {
    ...normalizeRequirementDocument(document),
    content: document.content,
    change_summary: document.change_summary,
    outline: document.outline,
    revisions: document.revisions,
    linked_requirements: document.linked_requirements.map((item) => ({
      requirement_code: codeFrom(item.requirement_code, item.requirement_id),
      title: item.title,
      state: item.state,
      current_revision: item.current_revision,
    })),
    can_edit: document.can_edit,
  };
}

function normalizeDesignPrototype(prototype: RawDesignPrototypeSummary): DesignPrototypeSummary {
  return {
    ...normalizeDesignPrototypeContent(prototype),
    code: codeFrom(prototype.code, prototype.prototype_code, prototype.prototype_id),
    project_code: codeFrom(prototype.project_code, prototype.project_id),
    title: prototype.title ?? '',
    summary: prototype.summary ?? '',
    status: prototype.status ?? 'draft',
    current_revision: prototype.current_revision ?? 1,
    owner_code: codeFrom(prototype.owner_code, prototype.owner_principal_code, prototype.owner_principal_id),
    linked_requirements: (prototype.linked_requirements ?? []).map((link) => ({
      requirement_code: link.requirement_code,
      title: link.title,
      status: link.status,
      feature_code: link.feature_code ?? null,
      feature_name: link.feature_name ?? null,
    })),
    updated_at: prototype.updated_at ?? '',
  };
}

function normalizeDesignPrototypeDetail(prototype: RawDesignPrototypeDetail): DesignPrototypeDetail {
  return {
    ...normalizeDesignPrototype(prototype),
    ...normalizeDesignPrototypeContent(prototype, prototype.html_content),
    html_content: prototype.html_content ?? '',
    notes_markdown: prototype.notes_markdown ?? '',
    change_summary: prototype.change_summary ?? '',
    revisions: (prototype.revisions ?? []).map((revision) => ({
      ...normalizeDesignPrototypeContent(revision),
      code: codeFrom(revision.revision_code, revision.revision_id),
      revision: revision.revision,
      change_summary: revision.change_summary,
      has_notes: Boolean(revision.has_notes),
      created_by: codeFrom(revision.created_by_user_code, revision.created_by),
      created_at: revision.created_at,
    })),
    can_edit: Boolean(prototype.can_edit),
  };
}

function normalizeDesignPrototypeContent(content: Partial<DesignPrototypeContent>, html = ''): DesignPrototypeContent {
  return {
    content_kind: content.content_kind ?? (html.includes('<meta name="acp-prototype-kind" content="image">') ? 'image' : 'html'),
    external_url: content.external_url ?? null,
    file_name: content.file_name ?? null,
    file_mime_type: content.file_mime_type ?? null,
    file_size: content.file_size ?? null,
    file_sha256: content.file_sha256 ?? null,
    download_path: content.download_path ?? null,
  };
}

function normalizeTask(task: RawTaskSummary): TaskSummary {
  const code = codeFrom(task.code, task.task_code, task.task_id);
  return {
    code,
    feature_code: codeFrom(task.feature_code, task.feature_id),
    requirement_code: optionalCode(task.requirement_code, task.requirement_id),
    requirement_baseline_code: task.requirement_baseline_code ?? null,
    requirement_baseline_name: task.requirement_baseline_name ?? null,
    requirement_baseline_version: task.requirement_baseline_version ?? null,
    defect_code: optionalCode(task.defect_code, task.defect_id),
    title: task.title ?? '',
    brief: task.brief ?? null,
    profile: task.profile ?? 'builder',
    source: task.source ?? 'ad-hoc',
    status: task.status ?? 'draft',
    assignee_code: task.assignee_code ?? task.assignee_principal_code ?? task.assignee_principal_id ?? null,
    acceptance: task.acceptance ?? [],
    base_snapshot: task.base_snapshot ?? 0,
    created_at: task.created_at,
    completed_at: task.completed_at ?? null,
    cancelled_at: task.cancelled_at ?? null,
  };
}

function normalizeTaskRun(run: RawTaskRun): TaskRun {
  return {
    run_code: codeFrom(run.run_code, run.run_id),
    workspace_code: codeFrom(run.workspace_code, run.workspace_id),
    workspace_path: run.workspace_path ?? '',
    git_base: run.git_base ?? '',
    status: run.status ?? 'active',
    profile: run.profile ?? 'builder',
    principal_code: codeFrom(run.principal_code, run.principal_id),
    base_snapshot: run.base_snapshot ?? 0,
    started_at: run.started_at ?? '',
    finished_at: run.finished_at ?? null,
  };
}

function normalizeTaskEvidence(evidence: RawTaskEvidence): TaskEvidence {
  return {
    evidence_code: codeFrom(evidence.evidence_code, evidence.evidence_id),
    run_code: optionalCode(evidence.run_code, evidence.run_id),
    type: evidence.type ?? 'self_test',
    acceptance_refs: evidence.acceptance_refs ?? [],
    result: evidence.result ?? 'pass',
    command: evidence.command ?? null,
    summary: evidence.summary ?? null,
    report_uri: evidence.report_uri ?? null,
    recorded_at: evidence.recorded_at ?? '',
  };
}

function normalizeTaskArtifact(artifact: RawTaskArtifact): TaskArtifact {
  return {
    artifact_code: codeFrom(artifact.artifact_code, artifact.artifact_id),
    project_code: codeFrom(artifact.project_code, artifact.project_id),
    run_code: optionalCode(artifact.run_code, artifact.run_id),
    kind: artifact.kind ?? 'other',
    title: artifact.title ?? null,
    summary: artifact.summary ?? null,
    uri: artifact.uri ?? '',
    content_hash: artifact.content_hash ?? '',
    published: Boolean(artifact.published),
    published_at: artifact.published_at ?? null,
  };
}

function normalizeTaskStatus(task: RawTaskStatus): TaskDetail {
  const summary = normalizeTask(task);
  return {
    ...summary,
    source_requirement_revision: task.source_requirement_revision ?? null,
    project_code: codeFrom(task.project_code, task.project_id),
    project_document_code: optionalCode(task.project_document_code),
    requirement_document_code: optionalCode(task.requirement_document_code),
    requirement_title: task.requirement_title ?? null,
    requirement_body: task.requirement_body ?? null,
    requirement_acceptance_criteria: task.requirement_acceptance_criteria ?? [],
    requirement_open_questions: task.requirement_open_questions ?? [],
    defect_code: optionalCode(task.defect_code),
    derived_view: task.derived_view ?? '',
    assignee_principal_code: optionalCode(task.assignee_principal_code),
    validation_seams: task.validation_seams ?? [],
    scope: task.scope ?? null,
    runs: (task.runs ?? []).map((run) => normalizeTaskRun(run)),
    evidences: (task.evidences ?? []).map((evidence) => normalizeTaskEvidence(evidence)),
    artifacts: (task.artifacts ?? []).map((artifact) => normalizeTaskArtifact(artifact)),
    evidence_count: task.evidence_count ?? task.evidences?.length ?? 0,
    artifact_count: task.artifact_count ?? task.artifacts?.length ?? 0,
  };
}

function normalizeTaskGraph(graph: RawTaskGraph): TaskGraph {
  return {
    nodes: graph.nodes.map((node) => ({
      code: codeFrom(node.code, node.task_code, node.task_id),
      title: node.title ?? '',
      status: node.status ?? 'draft',
    })),
    edges: graph.edges,
  };
}

function normalizeDefect(defect: RawDefectSummary): DefectSummary {
  const code = codeFrom(defect.code, defect.defect_code, defect.defect_id);
  return {
    code,
    feature_code: codeFrom(defect.feature_code, defect.feature_id),
    title: defect.title ?? '',
    severity: defect.severity ?? 'low',
    status: defect.status ?? 'reported',
    reported_by: codeFrom(defect.reported_by, defect.reported_by_user_code),
    description: defect.description ?? '',
    found_in: defect.found_in ?? null,
    related_requirement_code: optionalCode(defect.related_requirement_code, defect.related_requirement),
    reported_at: defect.reported_at ?? null,
    fix_tasks: defect.fix_tasks ?? [],
  };
}

function normalizeEvidence(evidence: RawEvidence): Evidence {
  const code = codeFrom(evidence.code, evidence.evidence_code, evidence.evidence_id);
  return {
    code,
    task_code: codeFrom(evidence.task_code, evidence.task_id),
    run_code: codeFrom(evidence.run_code, evidence.run_id),
    type: evidence.type ?? 'manual',
    acceptance_refs: evidence.acceptance_refs ?? [],
    result: evidence.result ?? 'inconclusive',
    command: evidence.command ?? null,
    summary: evidence.summary ?? null,
    report_uri: evidence.report_uri ?? null,
    recorded_at: evidence.recorded_at ?? '',
  };
}

function normalizeUserAccount(user: RawUserAccount): UserAccount {
  const code = codeFrom(user.code, user.user_code, user.user_id);
  return {
    code,
    account: user.account ?? '',
    display_name: user.display_name ?? '',
    status: user.status === 'disabled' ? 'disabled' : 'active',
    is_system_admin: Boolean(user.is_system_admin),
    must_change_password: Boolean(user.must_change_password),
    created_at: user.created_at,
    pending_deletion: Boolean(user.pending_deletion),
    deleted_at: user.deleted_at ?? null,
  };
}

function normalizeDevice(device: RawDeviceSummary): DeviceSummary {
  const code = codeFrom(device.code, device.device_code, device.device_id);
  return {
    code,
    device_name: device.device_name ?? null,
    created_at: device.created_at ?? '',
    last_login_at: device.last_login_at ?? null,
    client_type: device.client_type ?? 'legacy',
    platform: device.platform ?? null,
    current: Boolean(device.current),
    session_count: device.session_count ?? 0,
    status: device.status ?? 'active',
  };
}

function normalizeProjectArtifact(artifact: RawProjectArtifact): ProjectArtifact {
  const code = codeFrom(artifact.code, artifact.artifact_code, artifact.artifact_id);
  return {
    code,
    project_code: codeFrom(artifact.project_code, artifact.project_id),
    task_code: artifact.task_code ?? artifact.task_id ?? null,
    kind: artifact.kind ?? 'other',
    title: artifact.title ?? null,
    summary: artifact.summary ?? null,
    uri: artifact.uri ?? '',
    content_hash: artifact.content_hash ?? '',
    published: Boolean(artifact.published),
    published_at: artifact.published_at ?? null,
  };
}

export function listTasks(query = '', projectCode?: string): Promise<TaskSummary[]> {
  return fetchEnvelope<RawTaskSummary[]>(`/tasks${appendQueryParam(query, 'project_code', projectCode)}`).then((items) => items.map((item) => normalizeTask(item)));
}

export function getTask(taskCode: string): Promise<TaskDetail> {
  return fetchEnvelope<RawTaskStatus>(`/tasks/${encodeURIComponent(taskCode)}`).then((task) => normalizeTaskStatus(task));
}

export function createTask(input: CreateTaskInput): Promise<{ code: string; status: 'draft'; base_snapshot: number }> {
  return fetchEnvelope<RawTaskSummary>('/tasks', {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((task) => ({
    code: codeFrom(task.code, task.task_code, task.task_id),
    status: 'draft' as const,
    base_snapshot: task.base_snapshot ?? 0,
  }));
}

export interface UpdateTaskContractInput {
  base_snapshot: number;
  title: string;
  brief: string;
  acceptance: Array<{ id: string; text: string }>;
  validation_seams: string[];
  scope: { writable_paths: string[] } | null;
}

export function updateTaskContract(taskCode: string, input: UpdateTaskContractInput): Promise<TaskDetail> {
  return fetchEnvelope<RawTaskStatus>(`/tasks/${encodeURIComponent(taskCode)}/contract`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((task) => normalizeTaskStatus(task));
}

export function cancelTask(taskCode: string, input: { base_snapshot: number; reason?: string }): Promise<TaskDetail> {
  return fetchEnvelope<RawTaskStatus>(`/tasks/${encodeURIComponent(taskCode)}/cancel`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((task) => normalizeTaskStatus(task));
}

export function taskHistory(taskCode: string): Promise<AuditEvent[]> {
  return fetchEnvelope<RawAuditEvent[]>(`/tasks/${encodeURIComponent(taskCode)}/history`).then((events) => events.map((event) => ({
    timestamp: event.timestamp ?? '',
    action: event.action ?? '',
    principal_code: codeFrom(event.principal_code, event.principal_id),
    run_code: optionalCode(event.run_code, event.run_id),
    from: event.from ?? null,
    to: event.to ?? null,
    base_snapshot: event.base_snapshot ?? 0,
  })));
}

export function listMembers(projectCode?: string): Promise<Member[]> {
  if (!projectCode) return Promise.resolve([]);
  const path = `/members?project_code=${encodeURIComponent(projectCode)}`;
  return fetchEnvelope<RawMember[]>(path).then((members) => members.map((member) => normalizeMember(member)));
}

export async function listProjects(teamCode?: string): Promise<ProjectSummary[]> {
  const path = teamCode ? `/projects?team_code=${encodeURIComponent(teamCode)}` : '/projects';
  const projects = await fetchEnvelope<RawProjectSummary[]>(path, {
    headers: { 'X-Principal-Code': accountPrincipalCode() },
  });
  return projects.map(normalizeProject).filter((project) => project.code.length > 0);
}

export async function reorderProjects(teamCode: string, projectCodes: string[]): Promise<void> {
  await fetchEnvelope<{ project_codes: string[] }>('/projects/order', {
    method: 'PUT',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify({ team_code: teamCode, project_codes: projectCodes }),
  });
}

export async function getProject(projectCode: string): Promise<ProjectSummary> {
  const project = await fetchEnvelope<RawProjectSummary>(`/projects/${encodeURIComponent(projectCode)}`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  });
  return normalizeProject(project);
}

export function getProjectHome(projectCode: string): Promise<ProjectHome> {
  return fetchEnvelope<ProjectHome>(`/projects/${encodeURIComponent(projectCode)}/home`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  });
}

export function updateProjectHome(projectCode: string, input: UpdateProjectHomeInput): Promise<ProjectHome> {
  return fetchEnvelope<ProjectHome>(`/projects/${encodeURIComponent(projectCode)}/home`, {
    method: 'PUT',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  });
}

export function bindProjectHomeDocument(projectCode: string, slot: ProjectHomeSlot, documentCode: string | null): Promise<ProjectHome> {
  return updateProjectHome(projectCode, { [`${slot}_document_code`]: documentCode });
}

export async function createProject(input: CreateProjectInput): Promise<ProjectSummary> {
  const project = await fetchEnvelope<RawProjectSummary>('/projects', {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify(projectCreatePayload(input)),
  });
  return normalizeProject(project);
}

export async function updateProject(projectCode: string, input: UpdateProjectInput): Promise<ProjectSummary> {
  const project = await fetchEnvelope<RawProjectSummary>(`/projects/${encodeURIComponent(projectCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify(projectUpdatePayload(input)),
  });
  return normalizeProject(project);
}

export async function updateProjectStatus(projectCode: string, status: 'active' | 'archived'): Promise<ProjectSummary> {
  const project = await fetchEnvelope<RawProjectSummary>(`/projects/${encodeURIComponent(projectCode)}/status`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify({ status }),
  });
  return normalizeProject(project);
}

export function listProjectRepositories(projectCode: string): Promise<ProjectRepository[]> {
  return fetchEnvelope<Array<{
    repository_code: string;
    project_code: string;
    name: string;
    purpose: string | null;
    remote_url: string;
    default_branch: string | null;
    status: 'active' | 'archived';
    can_manage: boolean;
    created_at: string;
    updated_at: string;
  }>>(`/projects/${encodeURIComponent(projectCode)}/repositories`, {
    headers: { 'X-Principal-Code': accountPrincipalCode() },
  }).then((items) => items.map((item) => ({ ...item, code: item.repository_code })));
}

export function createProjectRepository(projectCode: string, input: SaveProjectRepositoryInput): Promise<ProjectRepository> {
  return fetchEnvelope<Omit<ProjectRepository, 'code'> & { repository_code: string }>(`/projects/${encodeURIComponent(projectCode)}/repositories`, {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify(input),
  }).then((item) => ({ ...item, code: item.repository_code }));
}

export function updateProjectRepository(repositoryCode: string, input: Partial<SaveProjectRepositoryInput>): Promise<ProjectRepository> {
  return fetchEnvelope<Omit<ProjectRepository, 'code'> & { repository_code: string }>(`/repositories/${encodeURIComponent(repositoryCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify(input),
  }).then((item) => ({ ...item, code: item.repository_code }));
}

export async function listProjectMembers(projectCode: string, useLegacyRoster = false): Promise<Member[]> {
  if (useLegacyRoster) {
    return listMembers(projectCode);
  }
  try {
    const members = await fetchEnvelope<RawMember[]>(`/projects/${encodeURIComponent(projectCode)}/members`);
    return members.map((member) => normalizeMember(member));
  } catch (error) {
    // Compatibility reads remain scoped to the current project.
    if (projectCode === 'PROJECT-A' && error instanceof Error && error.message.startsWith('HTTP 404')) {
      return listMembers(projectCode);
    }
    throw error;
  }
}

export function addProjectMember(projectCode: string, input: AddProjectMemberInput): Promise<Pick<Member, 'code' | 'role'>> {
  return fetchEnvelope<RawMember>(`/projects/${encodeURIComponent(projectCode)}/members`, {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify({ user_code: input.user_code, role: input.role }),
  }).then((member) => ({ code: codeFrom(member.code, member.user_code), role: member.role ?? input.role }));
}

export function updateProjectMemberRole(projectCode: string, userCode: string, role: AddProjectMemberInput['role']): Promise<Member> {
  return fetchEnvelope<RawMember>(`/projects/${encodeURIComponent(projectCode)}/members/${encodeURIComponent(userCode)}`, {
    method: 'PATCH', headers: { 'X-Principal-Code': accountPrincipalCode() }, body: JSON.stringify({ role }),
  }).then(normalizeMember);
}

export function removeProjectMember(projectCode: string, userCode: string): Promise<{ code: string }> {
  return fetchEnvelope<{ code?: string; user_code?: string }>(`/projects/${encodeURIComponent(projectCode)}/members/${encodeURIComponent(userCode)}`, {
    method: 'DELETE',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
  }).then((result) => ({ code: codeFrom(result.code, result.user_code) }));
}

export interface ProjectPolicyPreview {
  member_policy: ProjectMemberPolicy;
  impact: { gained_read: number; gained_write: number; lost_write: number; lost_access: number; explicit_exceptions: number };
}

export function previewProjectPolicy(projectCode: string, policy: ProjectMemberPolicy): Promise<ProjectPolicyPreview> {
  return fetchEnvelope<ProjectPolicyPreview>(`/projects/${encodeURIComponent(projectCode)}/access-policy?member_policy=${policy}`, {
    headers: { 'X-Principal-Code': accountPrincipalCode() },
  });
}

export function updateProjectPolicy(projectCode: string, policy: ProjectMemberPolicy): Promise<{ project_code: string; member_policy: ProjectMemberPolicy }> {
  return fetchEnvelope<{ project_code: string; member_policy: ProjectMemberPolicy }>(`/projects/${encodeURIComponent(projectCode)}/access-policy`, {
    method: 'PUT', headers: { 'X-Principal-Code': accountPrincipalCode() }, body: JSON.stringify({ member_policy: policy }),
  });
}

export interface OwnershipTransfer {
  code: string;
  scope: 'team' | 'project';
  scope_code: string;
  target_user_code: string;
  initiated_by_code?: string;
  from_user_code?: string;
  scope_name?: string;
  status: 'pending' | 'accepted' | 'cancelled' | 'expired';
  expires_at: string;
}

export function listOwnershipTransfers(): Promise<OwnershipTransfer[]> {
  return fetchEnvelope<OwnershipTransfer[]>('/ownership-transfers', { headers: { 'X-Principal-Code': accountPrincipalCode() } });
}

export function createOwnershipTransfer(input: { scope: 'team' | 'project'; scope_code: string; target_user_code: string; reason?: string }): Promise<OwnershipTransfer> {
  return fetchEnvelope<OwnershipTransfer>('/ownership-transfers', { method: 'POST', headers: { 'X-Principal-Code': accountPrincipalCode() }, body: JSON.stringify(input) });
}

export function respondOwnershipTransfer(code: string, action: 'accept' | 'cancel'): Promise<OwnershipTransfer> {
  return fetchEnvelope<OwnershipTransfer>(`/ownership-transfers/${encodeURIComponent(code)}/${action}`, { method: 'POST', headers: { 'X-Principal-Code': accountPrincipalCode() }, body: '{}' });
}

export function resolveOwnership(input: { scope: 'team' | 'project'; scope_code: string; owner_user_code: string }): Promise<unknown> {
  return fetchEnvelope('/ownership/resolve', { method: 'POST', headers: { 'X-Principal-Code': accountPrincipalCode() }, body: JSON.stringify(input) });
}

export interface ClosureStatus {
  pending_deletion: boolean;
  teams: Array<{ code: string; name: string; ownership_pending: boolean }>;
  projects: Array<{ code: string; name: string; status: string; ownership_pending: boolean }>;
  open_tasks: Array<{ code: string; title: string; status: string }>;
  active_runs: Array<{ code: string; status: string }>;
}

export function closureStatus(): Promise<ClosureStatus> {
  return fetchEnvelope<ClosureStatus>('/account/closure', { headers: { 'X-Principal-Code': accountPrincipalCode() } });
}

function changeAccountClosure(action: 'begin' | 'cancel' | 'complete'): Promise<ClosureStatus> {
  return fetchEnvelope<ClosureStatus>(`/account/closure/${action}`, { method: 'POST', headers: { 'X-Principal-Code': accountPrincipalCode() }, body: '{}' });
}
export function beginAccountClosure(): Promise<ClosureStatus> { return changeAccountClosure('begin'); }
export function cancelAccountClosure(): Promise<ClosureStatus> { return changeAccountClosure('cancel'); }
export async function completeAccountClosure(): Promise<ClosureStatus> {
  const result = await changeAccountClosure('complete');
  clearWebSession();
  return result;
}

export function listDefects(query = '', projectCode?: string): Promise<DefectSummary[]> {
  return fetchEnvelope<RawDefectSummary[]>(`/defects${appendQueryParam(query, 'project_code', projectCode)}`).then((items) => items.map((item) => normalizeDefect(item)));
}

export function createDefect(input: CreateDefectInput): Promise<{ code: string; status: 'reported' }> {
  return fetchEnvelope<{ defect_code?: string; code?: string; status: 'reported' }>('/defects', {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((defect) => ({ code: codeFrom(defect.code, defect.defect_code), status: defect.status }));
}

export function transitionDefect(defectCode: string, input: { to: string; fix_task_code?: string }): Promise<{ code: string; status: string }> {
  return fetchEnvelope<{ defect_code?: string; code?: string; status: string }>(`/defects/${encodeURIComponent(defectCode)}/transition`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((defect) => ({ code: codeFrom(defect.code, defect.defect_code), status: defect.status }));
}

export function listFeatures(projectCode?: string): Promise<Feature[]> {
  const path = `/features${appendQueryParam('', 'project_code', projectCode)}`;
  const localFeatures = projectCode ? readProjectStructureStore(projectCode).features : [];
  return fetchEnvelope<RawFeature[]>(path)
    .then((items) => normalizeAndMergeFeatures(items, localFeatures))
    .catch((error) => {
      if (!projectCode || !isFallbackRouteError(error)) throw error;
      return normalizeAndMergeFeatures([], localFeatures);
    });
}

export async function listProjectModules(projectCode: string): Promise<ProjectModule[]> {
  const localStore = readProjectStructureStore(projectCode);
  try {
    const remote = await fetchEnvelope<RawProjectModule[]>(`/projects/${encodeURIComponent(projectCode)}/modules`);
    const features = await listFeatures(projectCode);
    return normalizeAndMergeModules(remote, features);
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    return normalizeAndMergeModules(localStore.modules, await listFeatures(projectCode));
  }
}

export async function createProjectModule(projectCode: string, input: CreateProjectModuleInput): Promise<ProjectModule> {
  const payload = { name: input.name, description: input.summary ?? null, sort_order: input.order };
  try {
    const module = await fetchEnvelope<RawProjectModule>(`/projects/${encodeURIComponent(projectCode)}/modules`, {
      method: 'POST',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify(payload),
    });
    const normalized = normalizeProjectModule(module);
    updateLocalEntity(projectCode, 'modules', normalized);
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    const normalized = normalizeProjectModule({
      code: nextLocalCode('MODULE', readProjectStructureStore(projectCode).modules.map((module) => module.code)),
      project_code: projectCode,
      name: input.name,
      summary: input.summary ?? null,
      status: 'active',
      order: input.order ?? readProjectStructureStore(projectCode).modules.length,
    });
    return updateLocalEntity(projectCode, 'modules', normalized);
  }
}

export async function updateProjectModule(projectCode: string, moduleCode: string, input: UpdateProjectModuleInput): Promise<ProjectModule> {
  try {
    const module = await fetchEnvelope<RawProjectModule>(`/modules/${encodeURIComponent(moduleCode)}`, {
      method: 'PATCH',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.summary !== undefined ? { description: input.summary } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.order !== undefined ? { sort_order: input.order } : {}),
      }),
    });
    const normalized = normalizeProjectModule(module);
    updateLocalEntity(projectCode, 'modules', normalized);
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    const current = readProjectStructureStore(projectCode).modules.find((module) => codeFrom(module.code, module.module_code, module.module_id) === moduleCode);
    const normalized = normalizeProjectModule({
      ...(current ?? {}),
      code: moduleCode,
      project_code: projectCode,
      name: input.name ?? current?.name ?? '',
      summary: input.summary ?? current?.summary ?? null,
      status: input.status ?? current?.status ?? 'active',
      order: input.order ?? current?.order ?? 0,
    });
    return updateLocalEntity(projectCode, 'modules', normalized);
  }
}

export async function reorderProjectModules(projectCode: string, moduleCodes: string[]): Promise<void> {
  try {
    await fetchEnvelope<{ module_codes: string[] }>(`/projects/${encodeURIComponent(projectCode)}/modules/order`, {
      method: 'PUT',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({ module_codes: moduleCodes }),
    });
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
  }
  const orderByCode = new Map(moduleCodes.map((code, order) => [code, order]));
  writeProjectStructureStore(projectCode, (store) => ({
    ...store,
    modules: store.modules.map((module) => ({ ...module, sort_order: orderByCode.get(codeFrom(module.code, module.module_code, module.module_id)) ?? module.sort_order ?? module.order ?? 0 })),
  }));
}

export async function listProjectPhases(projectCode: string): Promise<ProjectPhase[]> {
  const localStore = readProjectStructureStore(projectCode);
  try {
    const remote = await fetchEnvelope<RawProjectPhase[]>(`/projects/${encodeURIComponent(projectCode)}/phases`);
    return [...remote.map(normalizeProjectPhase), ...localStore.phases.map(normalizeProjectPhase)]
      .reduce<ProjectPhase[]>((accumulator, phase) => {
        if (accumulator.some((item) => item.code === phase.code)) return accumulator;
        accumulator.push(phase);
        return accumulator;
      }, [])
      .sort(sortByOrderThenName);
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    return localStore.phases.map(normalizeProjectPhase).sort(sortByOrderThenName);
  }
}

export async function createProjectPhase(projectCode: string, input: CreateProjectPhaseInput): Promise<ProjectPhase> {
  try {
    const phase = await fetchEnvelope<RawProjectPhase>(`/projects/${encodeURIComponent(projectCode)}/phases`, {
      method: 'POST',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({
        project_code: projectCode,
        name: input.name,
        goal: input.summary,
        sort_order: input.order,
        status: input.status,
        start_date: input.start_at ?? null,
        end_date: input.end_at ?? null,
      }),
    });
    const normalized = normalizeProjectPhase(phase);
    updateLocalEntity(projectCode, 'phases', normalized);
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    const normalized = normalizeProjectPhase({
      code: nextLocalCode('PHASE', readProjectStructureStore(projectCode).phases.map((phase) => phase.code)),
      project_code: projectCode,
      name: input.name,
      summary: input.summary ?? null,
      status: 'planned',
      order: input.order ?? readProjectStructureStore(projectCode).phases.length + 1,
      start_at: input.start_at ?? null,
      end_at: input.end_at ?? null,
    });
    return updateLocalEntity(projectCode, 'phases', normalized);
  }
}

export async function updateProjectPhase(projectCode: string, phaseCode: string, input: UpdateProjectPhaseInput): Promise<ProjectPhase> {
  try {
    const phase = await fetchEnvelope<RawProjectPhase>(`/phases/${encodeURIComponent(phaseCode)}`, {
      method: 'PATCH',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.summary !== undefined ? { goal: input.summary } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.order !== undefined ? { sort_order: input.order } : {}),
        ...(input.start_at !== undefined ? { start_date: input.start_at } : {}),
        ...(input.end_at !== undefined ? { end_date: input.end_at } : {}),
      }),
    });
    const normalized = normalizeProjectPhase(phase);
    updateLocalEntity(projectCode, 'phases', normalized);
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    const current = readProjectStructureStore(projectCode).phases.find((phase) => codeFrom(phase.code, phase.phase_code, phase.phase_id) === phaseCode);
    const normalized = normalizeProjectPhase({
      ...(current ?? {}),
      code: phaseCode,
      project_code: projectCode,
      name: input.name ?? current?.name ?? '',
      summary: input.summary ?? current?.summary ?? null,
      status: input.status ?? current?.status ?? 'planned',
      order: input.order ?? current?.order ?? 0,
      start_at: input.start_at ?? current?.start_at ?? null,
      end_at: input.end_at ?? current?.end_at ?? null,
    });
    return updateLocalEntity(projectCode, 'phases', normalized);
  }
}

export async function listProjectMilestones(projectCode: string): Promise<ProjectMilestone[]> {
  const localStore = readProjectStructureStore(projectCode);
  try {
    const remote = await fetchEnvelope<RawProjectMilestone[]>(`/projects/${encodeURIComponent(projectCode)}/milestones`);
    return [...remote.map(normalizeProjectMilestone), ...localStore.milestones.map(normalizeProjectMilestone)]
      .reduce<ProjectMilestone[]>((accumulator, milestone) => {
        if (accumulator.some((item) => item.code === milestone.code)) return accumulator;
        accumulator.push(milestone);
        return accumulator;
      }, [])
      .sort(sortByOrderThenName);
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    return localStore.milestones.map(normalizeProjectMilestone).sort(sortByOrderThenName);
  }
}

export async function createProjectMilestone(projectCode: string, input: CreateProjectMilestoneInput): Promise<ProjectMilestone> {
  try {
    const milestone = await fetchEnvelope<RawProjectMilestone>(`/projects/${encodeURIComponent(projectCode)}/milestones`, {
      method: 'POST',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({
        project_code: projectCode,
        name: input.name,
        goal: input.summary,
        phase_code: input.phase_code ?? null,
        phase_name: input.phase_name ?? null,
        sort_order: input.order,
        status: input.status,
        start_date: input.start_at ?? null,
        target_date: input.target_at ?? null,
      }),
    });
    const normalized = normalizeProjectMilestone(milestone);
    updateLocalEntity(projectCode, 'milestones', normalized);
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    const normalized = normalizeProjectMilestone({
      code: nextLocalCode('MILESTONE', readProjectStructureStore(projectCode).milestones.map((milestone) => milestone.code)),
      project_code: projectCode,
      phase_code: input.phase_code ?? null,
      phase_name: input.phase_name ?? null,
      name: input.name,
      summary: input.summary ?? null,
      status: 'planned',
      order: input.order ?? readProjectStructureStore(projectCode).milestones.length + 1,
      start_at: input.start_at ?? null,
      target_at: input.target_at ?? null,
    });
    return updateLocalEntity(projectCode, 'milestones', normalized);
  }
}

export async function updateProjectMilestone(projectCode: string, milestoneCode: string, input: UpdateProjectMilestoneInput): Promise<ProjectMilestone> {
  try {
    const milestone = await fetchEnvelope<RawProjectMilestone>(`/milestones/${encodeURIComponent(milestoneCode)}`, {
      method: 'PATCH',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.summary !== undefined ? { goal: input.summary } : {}),
        ...(input.phase_code !== undefined ? { phase_code: input.phase_code } : {}),
        ...(input.phase_name !== undefined ? { phase_name: input.phase_name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.order !== undefined ? { sort_order: input.order } : {}),
        ...(input.start_at !== undefined ? { start_date: input.start_at } : {}),
        ...(input.target_at !== undefined ? { target_date: input.target_at } : {}),
      }),
    });
    const normalized = normalizeProjectMilestone(milestone);
    updateLocalEntity(projectCode, 'milestones', normalized);
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    const current = readProjectStructureStore(projectCode).milestones.find((milestone) => codeFrom(milestone.code, milestone.milestone_code, milestone.milestone_id) === milestoneCode);
    const normalized = normalizeProjectMilestone({
      ...(current ?? {}),
      code: milestoneCode,
      project_code: projectCode,
      phase_code: input.phase_code ?? current?.phase_code ?? null,
      phase_name: input.phase_name ?? current?.phase_name ?? null,
      name: input.name ?? current?.name ?? '',
      summary: input.summary ?? current?.summary ?? null,
      status: input.status ?? current?.status ?? 'planned',
      order: input.order ?? current?.order ?? 0,
      start_at: input.start_at ?? current?.start_at ?? null,
      target_at: input.target_at ?? current?.target_at ?? null,
    });
    return updateLocalEntity(projectCode, 'milestones', normalized);
  }
}

export async function createFeature(input: CreateFeatureInput): Promise<Feature> {
  try {
    const feature = await fetchEnvelope<RawFeature>('/features', {
      method: 'POST',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({
        ...input,
        ...(input.order !== undefined ? { sort_order: input.order } : {}),
        order: undefined,
      }),
    });
    const normalized = normalizeFeature(feature);
    updateStoredFeature(input.project_code, { ...normalized });
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
    const normalized = normalizeFeature({
      code: nextLocalCode('FEATURE', readProjectStructureStore(input.project_code).features.map((feature) => feature.code)),
      project_code: input.project_code,
      title: input.title,
      goal: input.goal ?? null,
      status: input.status ?? 'active',
      sort_order: input.order ?? readProjectStructureStore(input.project_code).features.length,
      module_code: input.module_code ?? null,
      module_name: input.module_name ?? null,
      milestone_code: input.milestone_code ?? null,
      milestone_name: input.milestone_name ?? null,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
    });
    updateStoredFeature(input.project_code, { ...normalized });
    return normalized;
  }
}

export async function updateFeature(featureCode: string, input: UpdateFeatureInput, projectCode?: string): Promise<Feature> {
  const code = featureCode;
  const projectStore = projectCode ? readProjectStructureStore(projectCode) : null;
  const currentFeature = projectStore?.features.find((feature) => codeFrom(feature.code, feature.feature_code, feature.feature_id) === code);
  try {
    const feature = await fetchEnvelope<RawFeature>(`/features/${encodeURIComponent(featureCode)}`, {
      method: 'PATCH',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({
        ...input,
        ...(input.order !== undefined ? { sort_order: input.order } : {}),
        order: undefined,
      }),
    });
    const normalized = normalizeFeature(feature);
    if (projectCode) updateStoredFeature(projectCode, { ...normalized });
    return normalized;
  } catch (error) {
    if (!isFallbackRouteError(error) || !projectCode) throw error;
    const normalized = normalizeFeature({
      ...(currentFeature ?? {}),
      code,
      project_code: projectCode,
      title: input.title ?? currentFeature?.title ?? '',
      goal: input.goal ?? currentFeature?.goal ?? null,
      status: input.status ?? currentFeature?.status ?? 'active',
      sort_order: input.order ?? currentFeature?.order ?? 0,
      module_code: input.module_code ?? currentFeature?.module_code ?? null,
      module_name: input.module_name ?? currentFeature?.module_name ?? null,
      milestone_code: input.milestone_code ?? currentFeature?.milestone_code ?? null,
      milestone_name: input.milestone_name ?? currentFeature?.milestone_name ?? null,
      start_date: input.start_date === undefined ? (currentFeature?.start_date ?? currentFeature?.start_at ?? null) : input.start_date,
      end_date: input.end_date === undefined ? (currentFeature?.end_date ?? currentFeature?.end_at ?? null) : input.end_date,
    });
    updateStoredFeature(projectCode, { ...normalized });
    return normalized;
  }
}

export async function reorderFeatures(projectCode: string, featureCodes: string[]): Promise<void> {
  try {
    await fetchEnvelope<{ feature_codes: string[] }>(`/projects/${encodeURIComponent(projectCode)}/features/order`, {
      method: 'PUT',
      headers: { 'X-Principal-Code': currentPrincipalCode() },
      body: JSON.stringify({ feature_codes: featureCodes }),
    });
  } catch (error) {
    if (!isFallbackRouteError(error)) throw error;
  }
  const orderByCode = new Map(featureCodes.map((code, order) => [code, order]));
  writeProjectStructureStore(projectCode, (store) => ({
    ...store,
    features: store.features.map((feature) => ({ ...feature, sort_order: orderByCode.get(codeFrom(feature.code, feature.feature_code, feature.feature_id)) ?? feature.sort_order ?? feature.order ?? 0 })),
  }));
}

export function listRequirements(projectCode?: string): Promise<Requirement[]> {
  return fetchEnvelope<RawRequirement[]>(`/requirements${appendQueryParam('', 'project_code', projectCode)}`).then((items) => items.map((item) => normalizeRequirement(item)));
}

export function getRequirement(requirementCode: string): Promise<RequirementDetail> {
  return fetchEnvelope<RawRequirement>(`/requirements/${encodeURIComponent(requirementCode)}`).then((requirement) => normalizeRequirement(requirement) as RequirementDetail);
}

export function createRequirement(input: CreateRequirementInput): Promise<Requirement> {
  return fetchEnvelope<RawRequirement>('/requirements', {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((requirement) => normalizeRequirement(requirement));
}

export function updateRequirement(requirementCode: string, input: UpdateRequirementInput): Promise<Requirement> {
  return fetchEnvelope<RawRequirement>(`/requirements/${encodeURIComponent(requirementCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((requirement) => normalizeRequirement(requirement));
}

export function transitionRequirement(requirementCode: string, status: RequirementStatus): Promise<Requirement> {
  return fetchEnvelope<RawRequirement>(`/requirements/${encodeURIComponent(requirementCode)}/transition`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify({ status }),
  }).then((requirement) => normalizeRequirement(requirement));
}

export function listRequirementDocuments(projectCode: string, query?: string): Promise<RequirementDocumentSummary[]> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set('q', query.trim());
  const suffix = params.size ? `?${params.toString()}` : '';
  return fetchEnvelope<RawRequirementDocumentSummary[]>(`/projects/${encodeURIComponent(projectCode)}/requirement-documents${suffix}`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((items) => items.map((item) => normalizeRequirementDocument(item)));
}

export function getRequirementDocument(documentCode: string): Promise<RequirementDocumentDetail> {
  return fetchEnvelope<RawRequirementDocumentDetail>(`/requirement-documents/${encodeURIComponent(documentCode)}`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((document) => normalizeRequirementDocumentDetail(document));
}

export function createRequirementDocument(projectCode: string, input: RequirementDocumentInput): Promise<RequirementDocumentSummary> {
  return fetchEnvelope<RawRequirementDocumentSummary>(`/projects/${encodeURIComponent(projectCode)}/requirement-documents`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((document) => normalizeRequirementDocument(document));
}

export function reviseRequirementDocument(documentCode: string, input: RequirementDocumentInput): Promise<RequirementDocumentSummary> {
  return fetchEnvelope<RawRequirementDocumentSummary>(`/requirement-documents/${encodeURIComponent(documentCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((document) => normalizeRequirementDocument(document));
}

export function listRequirementIdeas(projectCode: string, query?: string): Promise<RequirementIdea[]> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set('q', query.trim());
  const suffix = params.size ? `?${params.toString()}` : '';
  return fetchEnvelope<RequirementIdea[]>(`/projects/${encodeURIComponent(projectCode)}/ideas${suffix}`, { headers: { 'X-Principal-Code': currentPrincipalCode() } });
}

export function createRequirementIdea(projectCode: string, input: { title: string; detail?: string; source?: string }): Promise<RequirementIdea> {
  return fetchEnvelope<RequirementIdea>(`/projects/${encodeURIComponent(projectCode)}/ideas`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify(input) });
}

export function updateRequirementIdea(ideaCode: string, input: Partial<Pick<RequirementIdea, 'title' | 'detail' | 'source' | 'status'>>): Promise<RequirementIdea> {
  return fetchEnvelope<RequirementIdea>(`/ideas/${encodeURIComponent(ideaCode)}`, { method: 'PATCH', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify(input) });
}

export function listRequirementTopics(projectCode: string, query?: string): Promise<RequirementTopicSummary[]> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set('q', query.trim());
  const suffix = params.size ? `?${params.toString()}` : '';
  return fetchEnvelope<RequirementTopicSummary[]>(`/projects/${encodeURIComponent(projectCode)}/requirement-topics${suffix}`, { headers: { 'X-Principal-Code': currentPrincipalCode() } });
}

export function createRequirementTopic(projectCode: string, input: { title: string; problem_statement?: string; goal?: string; idea_codes?: string[] }): Promise<RequirementTopicSummary> {
  return fetchEnvelope<RequirementTopicSummary>(`/projects/${encodeURIComponent(projectCode)}/requirement-topics`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify(input) });
}

export function getRequirementTopic(topicCode: string): Promise<RequirementTopicDetail> {
  return fetchEnvelope<RequirementTopicDetail>(`/requirement-topics/${encodeURIComponent(topicCode)}`, { headers: { 'X-Principal-Code': currentPrincipalCode() } });
}

export function addRequirementTopicEntry(topicCode: string, input: { entry_type: RequirementTopicEntryType; content: string; rationale?: string; supersedes_entry_code?: string; source_entity_type?: string; source_entity_code?: string; images?: RequirementTopicEntryImageInput[] }): Promise<RequirementTopicEntry> {
  return fetchEnvelope<RequirementTopicEntry>(`/requirement-topics/${encodeURIComponent(topicCode)}/entries`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify(input) });
}

export function withdrawRequirementTopicEntry(entryCode: string, reason?: string): Promise<{ entry_code: string; withdrawn_at: string; withdrawn_by_code: string; withdrawn_by_name: string; withdrawal_reason: string | null }> {
  return fetchEnvelope(`/requirement-topic-entries/${encodeURIComponent(entryCode)}/withdraw`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify({ reason }) });
}

export function linkRequirementTopicIdeas(topicCode: string, ideaCodes: string[]): Promise<RequirementTopicDetail> {
  return fetchEnvelope<RequirementTopicDetail>(`/requirement-topics/${encodeURIComponent(topicCode)}/ideas`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify({ idea_codes: ideaCodes }) });
}

export function linkRequirementTopicDocuments(topicCode: string, documentCodes: string[]): Promise<RequirementTopicDetail> {
  return fetchEnvelope<RequirementTopicDetail>(`/requirement-topics/${encodeURIComponent(topicCode)}/documents`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify({ document_codes: documentCodes }) });
}

export function listRequirementDocumentReviews(documentCode: string): Promise<RequirementDocumentReview[]> {
  return fetchEnvelope<RequirementDocumentReview[]>(`/requirement-documents/${encodeURIComponent(documentCode)}/reviews`, { headers: { 'X-Principal-Code': currentPrincipalCode() } });
}

export function startRequirementDocumentReview(documentCode: string): Promise<RequirementDocumentReview> {
  return fetchEnvelope<RequirementDocumentReview>(`/requirement-documents/${encodeURIComponent(documentCode)}/reviews`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: '{}' });
}

export function voteRequirementDocumentReview(reviewCode: string, vote: RequirementReviewVote, comment = ''): Promise<RequirementDocumentReview> {
  return fetchEnvelope<RequirementDocumentReview>(`/requirement-document-reviews/${encodeURIComponent(reviewCode)}/vote`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify({ vote, comment }) });
}

export function closeRequirementDocumentReview(reviewCode: string, conclusion: 'passed' | 'changes_requested' | 'no_consensus'): Promise<RequirementDocumentReview> {
  return fetchEnvelope<RequirementDocumentReview>(`/requirement-document-reviews/${encodeURIComponent(reviewCode)}/close`, { method: 'POST', headers: { 'X-Principal-Code': currentPrincipalCode() }, body: JSON.stringify({ conclusion }) });
}

export function listDesignPrototypes(projectCode: string, query?: string): Promise<DesignPrototypeSummary[]> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set('q', query.trim());
  const suffix = params.size ? `?${params.toString()}` : '';
  return fetchEnvelope<RawDesignPrototypeSummary[]>(`/projects/${encodeURIComponent(projectCode)}/design-prototypes${suffix}`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((items) => items.map((item) => normalizeDesignPrototype(item)));
}

export function getDesignPrototype(prototypeCode: string): Promise<DesignPrototypeDetail> {
  return fetchEnvelope<RawDesignPrototypeDetail>(`/design-prototypes/${encodeURIComponent(prototypeCode)}`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((prototype) => normalizeDesignPrototypeDetail(prototype));
}

export function createDesignPrototype(projectCode: string, input: DesignPrototypeInput): Promise<DesignPrototypeDetail> {
  return fetchEnvelope<RawDesignPrototypeDetail>(`/projects/${encodeURIComponent(projectCode)}/design-prototypes`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((prototype) => normalizeDesignPrototypeDetail(prototype));
}

export function reviseDesignPrototype(prototypeCode: string, input: DesignPrototypeInput): Promise<DesignPrototypeDetail> {
  return fetchEnvelope<RawDesignPrototypeDetail>(`/design-prototypes/${encodeURIComponent(prototypeCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((prototype) => normalizeDesignPrototypeDetail(prototype));
}

export async function getDesignPrototypeFile(prototypeCode: string, revision: number): Promise<Blob> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(t('设计资料版本无效'));
  const path = `/design-prototypes/${encodeURIComponent(prototypeCode)}/file?revision=${revision}`;
  const headers = new Headers({ 'X-Principal-Code': currentPrincipalCode() });
  const token = authToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // Never use a server-provided download URL with the user's bearer credential.
  const response = await fetch(`/api${path}`, { headers, redirect: 'error' });
  if (!response.ok) {
    if (response.status === 401) {
      clearWebSession();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('acp:auth-expired'));
    }
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (body?.error?.code && body.error.message) throw new ApiError(body.error.code, body.error.message, response.status);
    throw new Error(body?.error?.message || t('文件下载失败（HTTP {status}）', { status: response.status }));
  }
  return response.blob();
}

export function getTaskGraph(projectCode?: string): Promise<TaskGraph> {
  return fetchEnvelope<RawTaskGraph>(`/tasks/graph${appendQueryParam('', 'project_code', projectCode)}`).then((graph) => normalizeTaskGraph(graph));
}

export function listTaskEvidences(taskCode: string): Promise<Evidence[]> {
  return fetchEnvelope<RawEvidence[]>(`/tasks/${encodeURIComponent(taskCode)}/evidences`).then((items) => items.map((item) => normalizeEvidence(item)));
}

export interface UserAccount {
  code: string;
  account: string;
  display_name: string;
  status: 'active' | 'disabled';
  is_system_admin: boolean;
  must_change_password: boolean;
  created_at?: string;
  pending_deletion?: boolean;
  deleted_at?: string | null;
}

export interface UserDirectoryEntry {
  code: string;
  account: string;
  display_name: string;
}

export interface DeviceSummary {
  code: string;
  device_name: string | null;
  created_at: string;
  last_login_at: string | null;
  client_type: string;
  platform: string | null;
  current: boolean;
  session_count: number;
  status: string;
}

export interface DeviceSessionSummary {
  code: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  current: boolean;
  status: string;
}

export interface DeviceAuthorizationRequest {
  user_code: string;
  device_name: string;
  client_type: string;
  platform: string | null;
  expires_at: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
}

export interface CreateUserInput {
  account: string;
  display_name: string;
}

export interface CreateUserResult {
  code: string;
  account: string;
  initial_password: string;
  expires_at: string;
}

export interface BindTokenResult {
  code: string;
  account: string;
  bind_token: string;
  expires_at: string;
}

export function currentPrincipalCode(): string {
  return storedAuthUser()?.code ?? '';
}

const accountPrincipalCode = currentPrincipalCode;

async function persistWebLogin(login: WebLoginResult): Promise<AuthUser> {
  window.localStorage.setItem(AUTH_TOKEN_KEY, login.device_token);
  try {
    const user = normalizeAuthUser(await fetchEnvelope<RawAuthUser>('/auth/whoami'));
    window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    return user;
  } catch (error) {
    clearWebSession();
    throw error;
  }
}

export async function loginWebSession(input: { account: string; password: string; device_name: string }): Promise<AuthUser> {
  clearWebSession();
  const login = await fetchEnvelope<WebLoginResult>('/auth/password-login', {
    method: 'POST',
    body: JSON.stringify({ ...input, device_identity: webClientIdentity() }),
  });
  return persistWebLogin(login);
}

export async function changeWebPassword(newPassword: string, currentPassword?: string): Promise<AuthUser> {
  await fetchEnvelope<{ code: string }>('/auth/password-change', {
    method: 'POST',
    body: JSON.stringify({ new_password: newPassword, ...(currentPassword ? { current_password: currentPassword } : {}) }),
  });
  return restoreWebSession();
}

export async function restoreWebSession(): Promise<AuthUser> {
  const user = normalizeAuthUser(await fetchEnvelope<RawAuthUser>('/auth/whoami'));
  window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  if (!user.must_change_password) {
    // Legacy credentials may not yet have an installation identity. Binding is authenticated,
    // and a collision must never merge devices or invalidate an otherwise usable login.
    await fetchEnvelope('/auth/device-identity', { method: 'POST', body: JSON.stringify({ device_identity: webClientIdentity() }) }).catch(() => undefined);
  }
  return user;
}

export async function logoutWebSession(): Promise<void> {
  try {
    await fetchEnvelope('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  } finally {
    clearWebSession();
  }
}

export function listTeams(): Promise<TeamSummary[]> {
  return fetchEnvelope<RawTeamSummary[]>('/teams', { headers: { 'X-Principal-Code': currentPrincipalCode() } }).then((teams) => teams.map((team) => normalizeTeam(team)));
}

export async function reorderTeams(teamCodes: string[]): Promise<void> {
  await fetchEnvelope<{ team_codes: string[] }>('/teams/order', {
    method: 'PUT',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify({ team_codes: teamCodes }),
  });
}

export function createTeam(input: CreateTeamInput): Promise<TeamSummary> {
  return fetchEnvelope<RawTeamSummary>('/teams', {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((team) => normalizeTeam(team));
}

export function renameTeam(teamCode: string, name: string): Promise<TeamSummary> {
  return fetchEnvelope<RawTeamSummary>(`/teams/${encodeURIComponent(teamCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify({ name }),
  }).then((team) => normalizeTeam(team));
}

export function listTeamMembers(teamCode: string): Promise<Member[]> {
  return fetchEnvelope<RawMember[]>(`/teams/${encodeURIComponent(teamCode)}/members`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((members) => members.map((member) => normalizeMember(member)));
}

export function addTeamMember(teamCode: string, input: AddTeamMemberInput): Promise<Member> {
  return fetchEnvelope<RawMember>(`/teams/${encodeURIComponent(teamCode)}/members`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify({ user_code: input.user_code, role: input.role }),
  }).then((member) => normalizeMember(member));
}

export function updateTeamMemberRole(teamCode: string, userCode: string, role: AddTeamMemberInput['role']): Promise<Member> {
  return fetchEnvelope<RawMember>(`/teams/${encodeURIComponent(teamCode)}/members/${encodeURIComponent(userCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify({ role }),
  }).then((member) => normalizeMember(member));
}

export function removeTeamMember(teamCode: string, userCode: string): Promise<{ code: string }> {
  return fetchEnvelope<{ code?: string; user_code?: string }>(`/teams/${encodeURIComponent(teamCode)}/members/${encodeURIComponent(userCode)}`, {
    method: 'DELETE',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((result) => ({ code: codeFrom(result.code, result.user_code) }));
}

export interface TeamMemberRemovalImpact {
  projects: Array<{ project_code: string; name: string; role: string; access_source?: ProjectAccessSource }>;
  blocked_owned_projects: Array<{ project_code: string; name: string }>;
  open_tasks: Array<{ task_code: string; title?: string }>;
  active_runs: Array<{ run_code: string; task_code: string; status: string }>;
}

export function getTeamMemberRemovalImpact(teamCode: string, userCode: string): Promise<TeamMemberRemovalImpact> {
  return fetchEnvelope<TeamMemberRemovalImpact>(`/teams/${encodeURIComponent(teamCode)}/members/${encodeURIComponent(userCode)}/removal-impact`, {
    headers: { 'X-Principal-Code': accountPrincipalCode() },
  });
}

export function listProjectArtifacts(projectCode: string): Promise<ProjectArtifact[]> {
  return fetchEnvelope<RawProjectArtifact[]>(`/projects/${encodeURIComponent(projectCode)}/artifacts`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((items) => items.map((item) => normalizeProjectArtifact(item)));
}

export function getProjectDocument(projectCode: string): Promise<ProjectDocument> {
  return fetchEnvelope<RawProjectDocument>(`/projects/${encodeURIComponent(projectCode)}/document`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  }).then((document) => normalizeProjectDocument(document));
}

export function saveProjectDocument(projectCode: string, input: { title: string; content: string }): Promise<ProjectDocument> {
  return fetchEnvelope<RawProjectDocument>(`/projects/${encodeURIComponent(projectCode)}/document`, {
    method: 'PUT',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((document) => normalizeProjectDocument(document));
}

export function listHandoffLibrary(projectCode: string, query = ''): Promise<HandoffLibrary> {
  const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
  return fetchEnvelope<HandoffLibrary>(`/projects/${encodeURIComponent(projectCode)}/handoff${suffix}`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  });
}

export function createHandoffFolder(projectCode: string, input: { name: string; parent_folder_code?: string | null }): Promise<HandoffFolder> {
  return fetchEnvelope<HandoffFolder>(`/projects/${encodeURIComponent(projectCode)}/handoff/folders`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  });
}

export function updateHandoffFolder(folderCode: string, input: { name?: string; parent_folder_code?: string | null; status?: HandoffDocumentStatus }): Promise<HandoffFolder> {
  return fetchEnvelope<HandoffFolder>(`/handoff-folders/${encodeURIComponent(folderCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  });
}

export function createHandoffDocument(projectCode: string, input: HandoffDocumentInput): Promise<HandoffDocumentSummary> {
  return fetchEnvelope<HandoffDocumentSummary>(`/projects/${encodeURIComponent(projectCode)}/handoff/documents`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  });
}

export function listArchitectureDocuments(projectCode: string, query = ''): Promise<ArchitectureDocumentSummary[]> {
  const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/architecture-documents${suffix}`);
}

export function getArchitectureDocument(documentCode: string): Promise<ArchitectureDocumentDetail> {
  return fetchEnvelope(`/architecture-documents/${encodeURIComponent(documentCode)}`);
}

export function createArchitectureDocument(projectCode: string, input: ArchitectureDocumentInput): Promise<ArchitectureDocumentDetail> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/architecture-documents`, { method: 'POST', body: JSON.stringify(input) });
}

export function reviseArchitectureDocument(documentCode: string, input: ArchitectureDocumentRevisionInput): Promise<ArchitectureDocumentDetail> {
  return fetchEnvelope(`/architecture-documents/${encodeURIComponent(documentCode)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function getHandoffDocument(documentCode: string): Promise<HandoffDocumentDetail> {
  return fetchEnvelope<HandoffDocumentDetail>(`/handoff-documents/${encodeURIComponent(documentCode)}`, {
    headers: { 'X-Principal-Code': currentPrincipalCode() },
  });
}

export function reviseHandoffDocument(documentCode: string, input: HandoffDocumentInput): Promise<HandoffDocumentDetail> {
  return fetchEnvelope<HandoffDocumentDetail>(`/handoff-documents/${encodeURIComponent(documentCode)}`, {
    method: 'PATCH',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  });
}

export function createProjectArtifact(projectCode: string, input: CreateProjectArtifactInput): Promise<ProjectArtifact> {
  return fetchEnvelope<RawProjectArtifact>(`/projects/${encodeURIComponent(projectCode)}/artifacts`, {
    method: 'POST',
    headers: { 'X-Principal-Code': currentPrincipalCode() },
    body: JSON.stringify(input),
  }).then((artifact) => normalizeProjectArtifact(artifact));
}

export function listUsers(): Promise<UserAccount[]> {
  return fetchEnvelope<RawUserAccount[]>('/users').then((users) => users.map((user) => normalizeUserAccount(user)));
}

export function listUserDirectory(): Promise<UserDirectoryEntry[]> {
  return fetchEnvelope<RawUserDirectoryEntry[]>('/users/directory').then((users) => users.map((user) => {
    const code = codeFrom(user.code, user.user_code, user.user_id);
    return {
      code,
      account: user.account ?? '',
      display_name: user.display_name ?? '',
    };
  }));
}

export function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  return fetchEnvelope<RawCreateUserResult>('/users', {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify(input),
  }).then((result) => ({
    code: codeFrom(result.code, result.user_code, result.user_id),
    account: result.account,
    initial_password: result.initial_password,
    expires_at: result.expires_at,
  }));
}

export function issueUserBindToken(userCode: string): Promise<BindTokenResult> {
  return fetchEnvelope<RawBindTokenResult>(`/users/${encodeURIComponent(userCode)}/bind-token`, {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify({}),
  }).then((result) => ({
    code: codeFrom(result.code, result.user_code, result.user_id),
    account: result.account,
    bind_token: result.bind_token,
    expires_at: result.expires_at,
  }));
}

export function issueUserInitialPassword(userCode: string): Promise<CreateUserResult> {
  return fetchEnvelope<RawCreateUserResult>(`/users/${encodeURIComponent(userCode)}/initial-password`, {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify({}),
  }).then((result) => ({
    code: codeFrom(result.code, result.user_code, result.user_id),
    account: result.account,
    initial_password: result.initial_password,
    expires_at: result.expires_at,
  }));
}

export function disableUser(userCode: string): Promise<{ code: string; status: 'disabled' }> {
  return fetchEnvelope<RawCreateUserResult>(`/users/${encodeURIComponent(userCode)}/disable`, {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify({}),
  }).then((result) => ({
    code: codeFrom(result.code, result.user_code, result.user_id),
    status: 'disabled' as const,
  }));
}

export function listDevices(userCode: string): Promise<DeviceSummary[]> {
  return fetchEnvelope<RawDeviceSummary[]>(`/devices?user_code=${encodeURIComponent(userCode)}`).then((devices) => devices.map((device) => normalizeDevice(device)));
}

export function listDeviceSessions(deviceCode: string): Promise<DeviceSessionSummary[]> {
  return fetchEnvelope(`/devices/${encodeURIComponent(deviceCode)}/sessions`);
}

export function renameDevice(deviceCode: string, deviceName: string): Promise<DeviceSummary> {
  return fetchEnvelope<RawDeviceSummary>(`/devices/${encodeURIComponent(deviceCode)}`, { method: 'PATCH', body: JSON.stringify({ device_name: deviceName }) }).then(normalizeDevice);
}

export function revokeSession(sessionCode: string): Promise<unknown> {
  return fetchEnvelope(`/sessions/${encodeURIComponent(sessionCode)}/revoke`, { method: 'POST', body: '{}' });
}

export function getDeviceAuthorizationRequest(userCode: string): Promise<DeviceAuthorizationRequest> {
  return fetchEnvelope(`/auth/device/request?${new URLSearchParams({ user_code: userCode })}`);
}

export function decideDeviceAuthorization(userCode: string, decision: 'approve' | 'deny'): Promise<unknown> {
  return fetchEnvelope('/auth/device/approve', { method: 'POST', body: JSON.stringify({ user_code: userCode, decision }) });
}

export function revokeDevice(deviceCode: string): Promise<{ code: string; user_code: string }> {
  return fetchEnvelope<{ code?: string; device_code?: string; device_id?: string; user_code?: string; principal_code?: string; principal_id?: string }>(`/devices/${encodeURIComponent(deviceCode)}/revoke`, {
    method: 'POST',
    headers: { 'X-Principal-Code': accountPrincipalCode() },
    body: JSON.stringify({}),
  }).then((result) => ({
    code: codeFrom(result.code, result.device_code, result.device_id),
    user_code: codeFrom(result.user_code, result.principal_code, result.principal_id),
  }));
}

export interface TeamProjectGovernance {
  project_code: string;
  name: string;
  status: 'active' | 'archived';
  owner_user_code: string | null;
  owner_name: string | null;
  can_access: boolean;
}

export function listTeamProjectGovernance(teamCode: string): Promise<TeamProjectGovernance[]> {
  return fetchEnvelope<TeamProjectGovernance[]>(`/teams/${encodeURIComponent(teamCode)}/projects-governance`, {
    headers: { 'X-Principal-Code': accountPrincipalCode() },
  });
}

// Testing shares wire contracts with the API and CLI; content and execution snapshots are versioned.
import type { TestCaseDetail, TestCaseSummary, TestCaseInput, TestCaseRevisionInput, TestAssetDetail, TestAssetSummary, TestAssetInput, TestAssetRevisionInput, TestExecutionDetail, TestExecutionSummary, TestExecutionInput, TestResultDefectInput } from '../../../packages/contracts/src/testing';
export type * from '../../../packages/contracts/src/testing';
export function listTestCases(projectCode: string, filters: Record<string, string> = {}): Promise<TestCaseSummary[]> {
  return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/test-cases?${new URLSearchParams(filters)}`);
}
export function getTestCase(code: string): Promise<TestCaseDetail> { return fetchEnvelope(`/test-cases/${encodeURIComponent(code)}`); }
export function createTestCase(projectCode: string, input: TestCaseInput): Promise<TestCaseDetail> { return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/test-cases`, { method: 'POST', body: JSON.stringify(input) }); }
export function reviseTestCase(code: string, input: TestCaseRevisionInput): Promise<TestCaseDetail> { return fetchEnvelope(`/test-cases/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(input) }); }
export function listTestAssets(projectCode: string, filters: Record<string, string> = {}): Promise<TestAssetSummary[]> { return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/test-assets?${new URLSearchParams(filters)}`); }
export function getTestAsset(code: string): Promise<TestAssetDetail> { return fetchEnvelope(`/test-assets/${encodeURIComponent(code)}`); }
function testAssetRequestBody(input: TestAssetInput | TestAssetRevisionInput): string {
  return JSON.stringify({ ...input, file: input.file ? { ...input.file, sha256: input.file.sha256 || undefined } : input.file });
}
export function createTestAsset(projectCode: string, input: TestAssetInput): Promise<TestAssetDetail> { return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/test-assets`, { method: 'POST', body: testAssetRequestBody(input) }); }
export function reviseTestAsset(code: string, input: TestAssetRevisionInput): Promise<TestAssetDetail> { return fetchEnvelope(`/test-assets/${encodeURIComponent(code)}`, { method: 'PATCH', body: testAssetRequestBody(input) }); }
export function listTestExecutions(projectCode: string, q = ''): Promise<TestExecutionSummary[]> { return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/test-executions?${new URLSearchParams({ q })}`); }
export function getTestExecution(code: string): Promise<TestExecutionDetail> { return fetchEnvelope(`/test-executions/${encodeURIComponent(code)}`); }
export function createTestExecution(projectCode: string, input: TestExecutionInput): Promise<TestExecutionDetail> { return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/test-executions`, { method: 'POST', body: JSON.stringify(input) }); }
export function linkTestResultDefect(executionCode: string, resultCode: string, input: TestResultDefectInput): Promise<TestExecutionDetail> { return fetchEnvelope(`/test-executions/${encodeURIComponent(executionCode)}/results/${encodeURIComponent(resultCode)}/defect`, { method: 'POST', body: JSON.stringify(input) }); }

import type { SkillSummary, SkillDetail, SkillScope, SkillCreateInput, SkillReviseInput, SkillShareInput, SkillInstallInput, ProjectSkills } from '../../../packages/contracts/src/skills';
export type * from '../../../packages/contracts/src/skills';
export function listSkills(scope: SkillScope, code: string, view: 'owned' | 'available' | 'shared' = 'owned'): Promise<SkillSummary[]> {
  return fetchEnvelope(`/skills?${new URLSearchParams({ [`${scope}_code`]: code, view })}`);
}
export function getSkill(code: string, projectCode?: string): Promise<SkillDetail> {
  return fetchEnvelope(`/skills/${encodeURIComponent(code)}${projectCode ? `?${new URLSearchParams({ project_code: projectCode })}` : ''}`);
}
export function createSkill(input: SkillCreateInput): Promise<SkillDetail> { return fetchEnvelope('/skills', { method: 'POST', body: JSON.stringify(input) }); }
export function reviseSkill(code: string, input: SkillReviseInput): Promise<SkillDetail> { return fetchEnvelope(`/skills/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(input) }); }
export function publishSkill(code: string, revision: number): Promise<SkillDetail> { return fetchEnvelope(`/skills/${encodeURIComponent(code)}/publish`, { method: 'POST', body: JSON.stringify({ revision }) }); }
export function archiveSkill(code: string, archived: boolean): Promise<SkillDetail> { return fetchEnvelope(`/skills/${encodeURIComponent(code)}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }); }
export function shareSkill(code: string, input: SkillShareInput): Promise<SkillDetail> { return fetchEnvelope(`/skills/${encodeURIComponent(code)}/shares`, { method: 'POST', body: JSON.stringify(input) }); }
export function revokeSkillShare(code: string, shareCode: string): Promise<SkillDetail> { return fetchEnvelope(`/skills/${encodeURIComponent(code)}/shares/${encodeURIComponent(shareCode)}`, { method: 'DELETE' }); }
export function getProjectSkills(projectCode: string): Promise<ProjectSkills> { return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/skills`); }
export function installProjectSkill(projectCode: string, code: string, input: SkillInstallInput): Promise<ProjectSkills> { return fetchEnvelope(`/projects/${encodeURIComponent(projectCode)}/skills/${encodeURIComponent(code)}`, { method: 'PUT', body: JSON.stringify(input) }); }
