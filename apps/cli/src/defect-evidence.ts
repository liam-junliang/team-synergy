import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEFECT_EVIDENCE_MAX_FILE_BYTES, DEFECT_EVIDENCE_MAX_ITEMS, type DefectEvidenceInput } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';

export interface DefectEvidenceOptions {
  evidenceText?: string[];
  evidenceUrl?: string[];
  evidenceFile?: string[];
}

const fileTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json',
  '.txt': 'text/plain', '.log': 'text/plain', '.pdf': 'application/pdf',
};

export function defectReportEvidence({ evidenceText = [], evidenceUrl = [], evidenceFile = [] }: DefectEvidenceOptions): DefectEvidenceInput[] {
  const count = evidenceText.length + evidenceUrl.length + evidenceFile.length;
  if (!count || count > DEFECT_EVIDENCE_MAX_ITEMS) {
    throw new DomainError('defect_report_invalid', `请提供 1 至 ${DEFECT_EVIDENCE_MAX_ITEMS} 项证据（--evidence-text、--evidence-url 或 --evidence-file）`);
  }
  const evidence: DefectEvidenceInput[] = [
    ...evidenceText.map(text => ({ kind: 'text' as const, text })),
    ...evidenceUrl.map(url => ({ kind: 'link' as const, url })),
  ];
  let remaining = DEFECT_EVIDENCE_MAX_FILE_BYTES;
  for (const filename of evidenceFile) {
    const stat = statSync(filename);
    if (!stat.isFile() || stat.size === 0 || stat.size > remaining) {
      throw new DomainError('defect_report_invalid', '请选择非空文件，全部附件合计最多 6 MiB');
    }
    const bytes = readFileSync(filename);
    remaining -= bytes.length;
    if (remaining < 0) throw new DomainError('defect_report_invalid', '全部附件合计最多 6 MiB');
    evidence.push({ kind: 'file', file_name: path.basename(filename),
      mime_type: fileTypes[path.extname(filename).toLowerCase()] ?? 'application/octet-stream',
      content_base64: bytes.toString('base64') });
  }
  return evidence;
}
