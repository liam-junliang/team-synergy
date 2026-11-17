import { fetchEnvelope } from './api';
import type { DocumentQualityPurpose, DocumentQualityReport } from '../../../packages/contracts/src/document-quality';

export type { DocumentQualityPurpose, DocumentQualityCheck } from '../../../packages/contracts/src/document-quality';

export interface DocumentQualityResponse extends DocumentQualityReport {
  project_code: string;
  diagram_source_sha256?: string;
  review: {
    status: 'not_requested' | 'open' | 'passed' | 'changes_requested' | 'no_consensus' | 'not_available';
    revision: number;
    review_code?: string;
  };
  adoption: { status: 'not_evaluated'; note: string };
}

export function getDocumentQuality(documentCode: string, revision: number, purpose?: DocumentQualityPurpose): Promise<DocumentQualityResponse> {
  const query = new URLSearchParams({ revision: String(revision) });
  if (purpose) query.set('purpose', purpose);
  return fetchEnvelope(`/handoff-documents/${encodeURIComponent(documentCode)}/quality?${query}`);
}

export function qualityReportMatches(report: DocumentQualityResponse | undefined, project: string, document: string, revision: number, purpose?: DocumentQualityPurpose): report is DocumentQualityResponse {
  return Boolean(report && report.project_code === project && report.document_code === document && report.revision === revision && (!purpose || report.purpose === purpose));
}

export const documentQualityPurposes: Record<DocumentQualityPurpose, string> = {
  reference: '参考资料', requirements: '需求规格', architecture: '架构设计', api: 'API 契约',
  operations: '运维手册', testing: '测试资料', overview: '项目说明', standards: '项目规范',
  security: '安全设计', nonfunctional: '非功能需求',
};
