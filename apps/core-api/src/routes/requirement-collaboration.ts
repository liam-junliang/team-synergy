import type { FastifyInstance } from 'fastify';
import {
  createRequirementCollaborationUseCases,
  type RequirementIdeaStatus,
  type RequirementReviewConclusion,
  type RequirementReviewVote,
  type RequirementTopicEntryType,
  type RequirementTopicStatus,
} from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { principalOf } from '../auth.js';

interface PrincipalBody { principal_code?: string; user_code?: string }
const stringsOf = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const topicImagesOf = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => {
  if (!item || typeof item !== 'object') return [];
  const image = item as Record<string, unknown>;
  return typeof image.file_name === 'string' && typeof image.data_url === 'string'
    ? [{ fileName: image.file_name, dataUrl: image.data_url }]
    : [];
}) : [];

export function registerRequirementCollaborationRoutes(app: FastifyInstance, db: Db): void {
  const uc = createRequirementCollaborationUseCases(db);

  app.get<{ Params: { project_code: string }; Querystring: { q?: string; status?: string } }>('/projects/:project_code/ideas', async (request) => (
    await uc.listIdeas({ projectCode: request.params.project_code, principalCode: principalOf(request), query: request.query.q, status: request.query.status as RequirementIdeaStatus | undefined })
  ));
  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/ideas', async (request) => {
    const body = request.body ?? {};
    return await uc.createIdea({ projectCode: request.params.project_code, principalCode: principalOf(request, body as PrincipalBody), title: String(body.title ?? ''), detail: typeof body.detail === 'string' ? body.detail : undefined, source: typeof body.source === 'string' ? body.source : undefined });
  });
  app.patch<{ Params: { idea_code: string }; Body: Record<string, unknown> }>('/ideas/:idea_code', async (request) => {
    const body = request.body ?? {};
    return await uc.updateIdea({ ideaCode: request.params.idea_code, principalCode: principalOf(request, body as PrincipalBody), title: typeof body.title === 'string' ? body.title : undefined, detail: typeof body.detail === 'string' ? body.detail : undefined, source: body.source === null ? null : typeof body.source === 'string' ? body.source : undefined, status: typeof body.status === 'string' ? body.status as RequirementIdeaStatus : undefined });
  });

  app.get<{ Params: { project_code: string }; Querystring: { q?: string; status?: string } }>('/projects/:project_code/requirement-topics', async (request) => (
    await uc.listTopics({ projectCode: request.params.project_code, principalCode: principalOf(request), query: request.query.q, status: request.query.status as RequirementTopicStatus | undefined })
  ));
  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/requirement-topics', async (request) => {
    const body = request.body ?? {};
    return await uc.createTopic({ projectCode: request.params.project_code, principalCode: principalOf(request, body as PrincipalBody), title: String(body.title ?? ''), problemStatement: typeof body.problem_statement === 'string' ? body.problem_statement : undefined, goal: typeof body.goal === 'string' ? body.goal : undefined, ideaCodes: stringsOf(body.idea_codes) });
  });
  app.get<{ Params: { topic_code: string } }>('/requirement-topics/:topic_code', async (request) => await uc.getTopic(request.params.topic_code, principalOf(request)));
  app.patch<{ Params: { topic_code: string }; Body: Record<string, unknown> }>('/requirement-topics/:topic_code', async (request) => {
    const body = request.body ?? {};
    return await uc.updateTopic({ topicCode: request.params.topic_code, principalCode: principalOf(request, body as PrincipalBody), title: typeof body.title === 'string' ? body.title : undefined, problemStatement: typeof body.problem_statement === 'string' ? body.problem_statement : undefined, goal: typeof body.goal === 'string' ? body.goal : undefined, status: typeof body.status === 'string' ? body.status as RequirementTopicStatus : undefined });
  });
  app.post<{ Params: { topic_code: string }; Body: Record<string, unknown> }>('/requirement-topics/:topic_code/entries', async (request) => {
    const body = request.body ?? {};
    return await uc.addTopicEntry({ topicCode: request.params.topic_code, principalCode: principalOf(request, body as PrincipalBody), entryType: String(body.entry_type ?? 'comment') as RequirementTopicEntryType, content: String(body.content ?? ''), rationale: typeof body.rationale === 'string' ? body.rationale : undefined, supersedesEntryCode: typeof body.supersedes_entry_code === 'string' ? body.supersedes_entry_code : undefined, sourceEntityType: typeof body.source_entity_type === 'string' ? body.source_entity_type : undefined, sourceEntityCode: typeof body.source_entity_code === 'string' ? body.source_entity_code : undefined, images: topicImagesOf(body.images) });
  });
  app.post<{ Params: { entry_code: string }; Body: Record<string, unknown> }>('/requirement-topic-entries/:entry_code/withdraw', async (request) => {
    const body = request.body ?? {};
    return await uc.withdrawTopicEntry({ entryCode: request.params.entry_code, principalCode: principalOf(request, body as PrincipalBody), reason: typeof body.reason === 'string' ? body.reason : undefined });
  });
  app.post<{ Params: { topic_code: string }; Body: Record<string, unknown> }>('/requirement-topics/:topic_code/ideas', async (request) => {
    const body = request.body ?? {};
    return await uc.linkIdeas({ topicCode: request.params.topic_code, principalCode: principalOf(request, body as PrincipalBody), ideaCodes: stringsOf(body.idea_codes) });
  });
  app.post<{ Params: { topic_code: string }; Body: Record<string, unknown> }>('/requirement-topics/:topic_code/documents', async (request) => {
    const body = request.body ?? {};
    return await uc.linkDocuments({ topicCode: request.params.topic_code, principalCode: principalOf(request, body as PrincipalBody), documentCodes: stringsOf(body.document_codes) });
  });

  app.get<{ Params: { document_code: string } }>('/requirement-documents/:document_code/reviews', async (request) => await uc.listDocumentReviews(request.params.document_code, principalOf(request)));
  app.post<{ Params: { document_code: string }; Body: Record<string, unknown> }>('/requirement-documents/:document_code/reviews', async (request) => await uc.startDocumentReview({ documentCode: request.params.document_code, principalCode: principalOf(request, (request.body ?? {}) as PrincipalBody) }));
  app.get<{ Params: { review_code: string } }>('/requirement-document-reviews/:review_code', async (request) => await uc.getDocumentReview(request.params.review_code, principalOf(request)));
  app.post<{ Params: { review_code: string }; Body: Record<string, unknown> }>('/requirement-document-reviews/:review_code/vote', async (request) => {
    const body = request.body ?? {};
    return await uc.voteDocumentReview({ reviewCode: request.params.review_code, principalCode: principalOf(request, body as PrincipalBody), vote: String(body.vote ?? '') as RequirementReviewVote, comment: typeof body.comment === 'string' ? body.comment : undefined });
  });
  app.post<{ Params: { review_code: string }; Body: Record<string, unknown> }>('/requirement-document-reviews/:review_code/close', async (request) => {
    const body = request.body ?? {};
    return await uc.closeDocumentReview({ reviewCode: request.params.review_code, principalCode: principalOf(request, body as PrincipalBody), conclusion: String(body.conclusion ?? '') as RequirementReviewConclusion });
  });
}
