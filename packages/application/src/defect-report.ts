import { DEFECT_EVIDENCE_MAX_FILE_BYTES, DEFECT_EVIDENCE_MAX_ITEMS, type DefectEvidence } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { normalizeTestFile, testText, testUrl } from './testing-content.js';

function invalid(message: string): never { throw new DomainError('defect_report_invalid', message); }

export function normalizeDefectReport(input: {
  title: unknown; description?: unknown; actionSteps: unknown; expectedResult: unknown; actualResult: unknown; evidence: unknown;
}) {
  try {
    const title = testText(input.title, '标题', 512, true).trim();
    const action_steps = testText(input.actionSteps, '操作步骤', 65536, true).trim();
    const expected_result = testText(input.expectedResult, '预期结果', 65536, true).trim();
    const actual_result = testText(input.actualResult, '实际结果', 65536, true).trim();
    const description = testText(input.description ?? '', '补充说明').trim();
    if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > DEFECT_EVIDENCE_MAX_ITEMS) {
      invalid(`请提供 1 到 ${DEFECT_EVIDENCE_MAX_ITEMS} 项缺陷证据`);
    }
    const evidence: DefectEvidence[] = [];
    const files: Array<{ evidence_index: number; content_base64: string }> = [];
    let totalBytes = 0;
    for (const item of input.evidence) {
      if (!item || typeof item !== 'object') invalid('证据格式不正确');
      switch (item.kind) {
        case 'text':
          evidence.push({ kind: 'text', text: testText(item.text, '证据文本', 65536, true) });
          break;
        case 'link':
          evidence.push({ kind: 'link', url: testUrl(item.url) });
          break;
        case 'file': {
          const file = normalizeTestFile(item);
          if (Buffer.from(file.file_name).toString('utf8') !== file.file_name) invalid('文件名必须是有效的 Unicode 文本');
          totalBytes += file.size_bytes;
          if (!file.size_bytes || totalBytes > DEFECT_EVIDENCE_MAX_FILE_BYTES) invalid('证据文件不能为空，附件合计最多 6 MiB');
          files.push({ evidence_index: evidence.length, content_base64: file.content_base64 });
          evidence.push({ kind: 'file', file_name: file.file_name, mime_type: file.mime_type, size_bytes: file.size_bytes, sha256: file.sha256 });
          break;
        }
        default:
          invalid('证据类型必须为 text、link 或 file');
      }
    }
    return { facts: { title, description, action_steps, expected_result, actual_result, evidence_json: JSON.stringify(evidence) }, files };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'testing_invalid') invalid(error.message);
    throw error;
  }
}
