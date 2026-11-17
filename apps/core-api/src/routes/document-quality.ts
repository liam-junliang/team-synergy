import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  createProjectDocumentUseCases,
  createRequirementCollaborationUseCases,
} from '@team-synergy/application';
import {
  DOCUMENT_QUALITY_PURPOSES,
  evaluateDocumentQuality,
  inferDocumentQualityPurpose,
  type DocumentQualityInput,
  type DocumentQualityPurpose,
  type DocumentQualityReport,
} from '@team-synergy/contracts';
import type { Db } from '@team-synergy/persistence';
import { principalOf } from '../auth.js';

type RecordValue = Record<string, unknown>;
type Review = {
  status: 'not_requested' | 'open' | 'passed' | 'changes_requested' | 'no_consensus' | 'not_available';
  revision: number;
  review_code?: string;
};

function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
}

function matchingRevision(value: unknown, revision: number): RecordValue[] {
  return Array.isArray(value)
    ? value.flatMap(item => { const row = record(item); return row?.revision === revision ? [row] : []; })
    : [];
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The same authenticated library view supplies every source; results never grant approval. */
export function registerDocumentQualityRoutes(app: FastifyInstance, db: Db): void {
  const documents = createProjectDocumentUseCases(db);
  const collaboration = createRequirementCollaborationUseCases(db);

  app.get<{
    Params: { document_code: string };
    Querystring: { revision?: unknown; purpose?: unknown };
  }>('/handoff-documents/:document_code/quality', async (request, reply) => {
    const query = request.query;
    if (query.revision !== undefined && (
      typeof query.revision !== 'string' || !/^[1-9]\d*$/.test(query.revision)
      || !Number.isSafeInteger(Number(query.revision))
    )) {
      return reply.code(400).send({ ok: false, error: {
        code: 'document_quality_revision_invalid', message: '质检版本必须是正整数',
      } });
    }
    if (query.purpose !== undefined && (
      typeof query.purpose !== 'string' || !DOCUMENT_QUALITY_PURPOSES.includes(query.purpose as DocumentQualityPurpose)
    )) {
      return reply.code(400).send({ ok: false, error: {
        code: 'document_quality_purpose_invalid', message: '不支持的文档质检用途',
      } });
    }
    const principal = principalOf(request);
    const result = await documents.getDocument(request.params.document_code, principal, { readOnly: true });
    if (!result.ok) return result;
    const document = result.data;
    const revision = query.revision === undefined ? document.current_revision : Number(query.revision);
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      return reply.code(409).send({ ok: false, error: {
        code: 'document_quality_revision_unavailable', message: '文档当前修订信息不完整，无法检查',
      } });
    }
    const matches = matchingRevision(document.revisions, revision);
    if (matches.length !== 1 || typeof matches[0]?.content !== 'string') {
      return reply.code(matches.length === 0 ? 404 : 409).send({ ok: false, error: {
        code: matches.length === 0 ? 'document_quality_revision_not_found' : 'document_quality_revision_unavailable',
        message: matches.length === 0 ? '指定的文档修订不存在，未回退到当前版本' : '文档修订信息不完整或存在歧义，无法检查',
      } });
    }
    const selected = matches[0];
    const content = selected.content as string;
    let title = typeof selected.title === 'string' ? selected.title : '';
    let diagramSource: string | undefined;
    let diagramHash: string | undefined;
    const notes: string[] = [];
    if (document.source_kind === 'requirement' && revision !== document.current_revision) {
      notes.push('需求文档历史修订未保存历史标题；本次按该修订的不可变正文检查，标题沿用当前展示标题，不代表历史标题已核验。');
    }
    if (document.source_kind === 'architecture') {
      const originals = matchingRevision(record(document.architecture_document)?.revisions, revision);
      if (originals.length !== 1 || typeof originals[0]?.source_content !== 'string') {
        return reply.code(409).send({ ok: false, error: {
          code: 'document_quality_revision_unavailable', message: '架构图原始修订信息不完整，无法检查',
        } });
      }
      const original = originals[0];
      title = typeof original.title === 'string' ? original.title : title;
      diagramHash = sha256(original.source_content as string);
      // Image pixels and XML are never interpreted as Markdown or executed.
      if (original.content_kind === 'mermaid') diagramSource = original.source_content as string;
      notes.push('图源哈希单独绑定该版本；仅对 Mermaid 文本提供结构提示，图形语义、XML 与图片内容尚未核验。');
    }
    const asset = record(document.testing_asset);
    const assetRevision = matchingRevision(asset?.revisions, revision)[0];
    if (document.source_kind === 'testing' && assetRevision?.storage_kind !== 'markdown') {
      notes.push('本次只检查该修订的说明正文；附件、外部链接与 Git 内容未解析、未访问，其内容质量尚未核验。');
    }
    const purpose = query.purpose as DocumentQualityPurpose | undefined ?? inferDocumentQualityPurpose({
      title,
      source_kind: typeof document.source_kind === 'string' ? document.source_kind : undefined,
      kind: typeof document.kind === 'string' ? document.kind : undefined,
    });
    const input: DocumentQualityInput = {
      document_code: request.params.document_code,
      revision,
      title,
      content,
      purpose,
      source_kind: typeof document.source_kind === 'string' ? document.source_kind : 'project',
      content_sha256: sha256(content),
      checked_at: new Date().toISOString(),
      ...(diagramSource === undefined ? {} : { diagram_source: diagramSource }),
    };
    const report: DocumentQualityReport = evaluateDocumentQuality(input);
    let review: Review = { status: 'not_available', revision };
    if (document.source_kind === 'requirement') {
      const reviews = await collaboration.listDocumentReviews(request.params.document_code, principal);
      if (!reviews.ok) return reviews;
      const matching = reviews.data.map(record).filter(row => row?.revision === revision);
      const item = matching[0];
      review = { status: 'not_requested', revision };
      if (item && typeof item.review_code === 'string') {
        const status = item.status === 'open' ? 'open'
          : item.conclusion === 'passed' || item.conclusion === 'changes_requested' || item.conclusion === 'no_consensus'
            ? item.conclusion : 'not_available';
        review = { status, revision, review_code: item.review_code };
      }
    }
    return { ok: true, data: {
      ...report,
      project_code: document.project_code,
      purpose_source: query.purpose === undefined ? 'inferred' : 'selected',
      scope_note: [report.scope_note, ...notes].join(' '),
      ...(diagramHash === undefined ? {} : { diagram_source_sha256: diagramHash }),
      review,
      adoption: { status: 'not_evaluated', note: '本次未核验正式规格或执行基线的采用关系；规则检查通过不代表已批准或已正式采用。' },
    } };
  });
}
