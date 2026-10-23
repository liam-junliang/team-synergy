import type { DocumentQualityReport } from './document-quality.js';

export const SYSTEM_AGENT_JOB_STATUSES = ['queued', 'running', 'awaiting_review', 'applied', 'rejected', 'failed', 'cancelled'] as const;
export type SystemAgentJobStatus = typeof SYSTEM_AGENT_JOB_STATUSES[number];

/** Draft only. The executor cannot adopt or publish this object. */
export interface SystemAgentProposal {
  title: string;
  summary: string;
  content: string;
  rationale: string;
  evidence: string[];
  warnings: string[];
}

export interface SystemAgentExecutionMetadata {
  engine: string;
  engine_version: string;
  model: string;
  skill_version: string;
  skill_sha256: string;
}

export interface SystemAgentJobView {
  job_code: string;
  project_code: string;
  document_code: string;
  document_title: string;
  base_revision: number;
  base_title: string;
  base_summary: string;
  base_content: string;
  instruction: string;
  quote: string | null;
  proposal: SystemAgentProposal | null;
  proposal_hash: string | null;
  quality: DocumentQualityReport | null;
  status: SystemAgentJobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  applied_revision: number | null;
  execution_metadata: SystemAgentExecutionMetadata | null;
  can_apply: boolean;
}

/** Private worker capability. Never returned by HTTP routes. */
export interface SystemAgentExecution extends SystemAgentJobView {
  execution_token: string;
}
