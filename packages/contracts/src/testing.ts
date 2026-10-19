export type TestPriority = 'low' | 'medium' | 'high' | 'critical';
export type TestMethod = 'manual' | 'automated';
export type TestAssetPurpose = 'guide' | 'script' | 'data' | 'environment' | 'report';
export type TestAssetStorage = 'markdown' | 'file' | 'url' | 'git';
export type TestResultStatus = 'not_run' | 'pass' | 'fail' | 'blocked' | 'skipped';
export interface TestStep { action: string; expected: string }
export interface TestFile { file_name: string; mime_type: string; content_base64: string; size_bytes: number; sha256: string }
export interface TestGit { repository_code: string; path: string; ref: string; commit: string; command: string; setup: string }
export interface TestCaseContent {
  title: string; summary: string; module_code: string | null; requirement_codes: string[];
  priority: TestPriority; method: TestMethod; suite: string; tags: string[];
  preconditions: string; steps: TestStep[]; notes_markdown: string; asset_codes: string[];
}
export interface TestAssetContent {
  title: string; summary: string; purpose: TestAssetPurpose; storage_kind: TestAssetStorage;
  content: string; url: string | null; file: TestFile | null; git: TestGit | null;
  module_code: string | null; requirement_codes: string[]; tags: string[];
}
export interface TestRevisionMetadata { revision_code: string; revision: number; change_summary: string; created_by_user_code: string; created_at: string }
export interface TestDocumentMetadata { code: string; project_code: string; current_revision: number; updated_at: string; owner_user_code: string; can_edit: boolean }
export interface TestCaseRevision extends TestCaseContent, TestRevisionMetadata {}
export interface TestAssetRevision extends TestAssetContent, TestRevisionMetadata {}
export interface TestCaseSummary extends TestCaseContent, TestDocumentMetadata {}
export interface TestAssetSummary extends Omit<TestAssetContent, 'file'>, TestDocumentMetadata { file: Omit<TestFile, 'content_base64'> | null }
export interface TestCaseDetail extends TestCaseSummary { revisions: TestCaseRevision[] }
export interface TestAssetDetail extends TestAssetContent, TestDocumentMetadata { revisions: TestAssetRevision[] }
export type TestCaseInput = Partial<TestCaseContent> & { title: string };
export type TestAssetInput = Partial<TestAssetContent> & { title: string };
export type TestCaseRevisionInput = Partial<TestCaseContent> & { base_revision: number; change_summary: string };
export type TestAssetRevisionInput = Partial<TestAssetContent> & { base_revision: number; change_summary: string };
export interface TestExecutionResultInput {
  case_code: string; case_revision: number; result: TestResultStatus; actual_result?: string; notes?: string; report_urls?: string[];
}
export interface TestExecutionInput {
  title: string; environment: string; tested_version: string; commit_sha?: string;
  source?: 'manual' | 'agent' | 'ci'; task_code?: string | null; notes_markdown?: string;
  asset_refs?: Array<{ asset_code: string; revision: number }>; results: TestExecutionResultInput[];
}
export interface TestExecutionSummary {
  code: string; project_code: string; title: string; environment: string; tested_version: string;
  commit_sha: string; source: 'manual' | 'agent' | 'ci'; task_code: string | null;
  notes_markdown: string; executor_user_code: string; created_at: string;
  counts: Record<TestResultStatus, number>;
}
export interface TestExecutionResult extends Required<TestExecutionResultInput> {
  result_code: string; snapshot: TestCaseRevision; defect_code: string | null; is_outdated: boolean;
}
export interface TestExecutionAsset {
  asset_code: string; revision: number; snapshot: Omit<TestAssetRevision, 'file' | 'git'> & {
    file: Omit<TestFile, 'content_base64'> | null; git: (TestGit & { remote_url: string }) | null;
  };
}
export interface TestExecutionDetail extends TestExecutionSummary { results: TestExecutionResult[]; assets: TestExecutionAsset[] }
export interface TestResultDefectInput { defect_code?: string; feature_code?: string; title?: string; severity?: 'critical' | 'high' | 'medium' | 'low' }
