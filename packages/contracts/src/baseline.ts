/** Frozen requirement content; metadata is captured rather than read from mutable requirements. */
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
  acceptance_criteria: Array<{ id: string; text: string }>;
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

export interface RequirementBaselineComparison {
  from_baseline_code: string;
  to_baseline_code: string | null;
  changes: Array<{
    requirement_code: string;
    kind: 'added' | 'modified' | 'removed';
    before: RequirementBaselineItem | null;
    after: RequirementBaselineItem | null;
    changed_fields: string[];
  }>;
  counts: { added: number; modified: number; removed: number };
}

/** Project-scoped graph attachments; handovers retain their frozen context binding. */
export interface RequirementBaselineBindings {
  tasks: Array<{
    task_code: string;
    title: string;
    status: string;
    baseline_code: string | null;
    baseline_version: number | null;
  }>;
  handovers: Array<{
    handover_code: string;
    task_code: string;
    task_title: string;
    status: string;
    baseline_code: string | null;
    baseline_version: number | null;
  }>;
}
