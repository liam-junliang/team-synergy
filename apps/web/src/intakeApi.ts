import { fetchEnvelope } from './api';
import { t } from './i18n.ts';
import type { IntakeBatchDetail, IntakeBundle, IntakeContext, IntakeDecision, IntakeItemView, IntakeKind, IntakeList, IntakeReviewInput } from '../../../packages/contracts/src/intake';

export type { IntakeBatchDetail, IntakeBundle, IntakeContext, IntakeDecision, IntakeItemView, IntakeKind, IntakeList, IntakeTarget } from '../../../packages/contracts/src/intake';
const path = (project: string, batch?: string) => `/projects/${encodeURIComponent(project)}/intake${batch ? `/${encodeURIComponent(batch)}` : ''}`;
export const getIntakeContext = (project: string): Promise<IntakeContext> => fetchEnvelope(`${path(project)}/context`);
export const listIntakes = (project: string): Promise<IntakeList> => fetchEnvelope(path(project));
export const getIntake = (project: string, batch: string): Promise<IntakeBatchDetail> => fetchEnvelope(path(project, batch));
export const submitIntake = (project: string, bundle: IntakeBundle, idempotencyKey: string): Promise<IntakeBatchDetail> => fetchEnvelope(path(project), { method: 'POST', body: JSON.stringify({ bundle, idempotency_key: idempotencyKey }) });
export const replaceIntake = (project: string, batch: string, bundle: IntakeBundle, revision: number): Promise<IntakeBatchDetail> => fetchEnvelope(path(project, batch), { method: 'PUT', body: JSON.stringify({ bundle, base_revision: revision }) });
export const reviewIntake = (project: string, batch: string, input: IntakeReviewInput): Promise<IntakeBatchDetail> => fetchEnvelope(`${path(project, batch)}/review`, { method: 'POST', body: JSON.stringify(input) });
export const applyIntake = (project: string, batch: string, planHash: string, idempotencyKey: string): Promise<IntakeBatchDetail> => fetchEnvelope(`${path(project, batch)}/apply`, { method: 'POST', body: JSON.stringify({ plan_hash: planHash, idempotency_key: idempotencyKey }) });
export const stopIntake = (project: string, batch: string, revision: number): Promise<IntakeBatchDetail> => fetchEnvelope(`${path(project, batch)}/stop`, { method: 'POST', body: JSON.stringify({ base_revision: revision }) });

export const intakeKinds: IntakeKind[] = ['module', 'feature', 'requirement_document', 'requirement', 'architecture'];
export const intakeKindLabels: Record<IntakeKind, string> = { module: '模块', feature: 'Feature', requirement_document: '需求文档', requirement: '需求', architecture: '架构设计' };
export const intakeStatusLabels: Record<string, string> = { draft: '待审阅', ready: '待发布', applying: '发布中', applied: '已发布', partial: '部分完成', cancelled: '已取消', stopped: '已停止', pending: '待处理', bound: '已关联', skipped: '已跳过', failed: '失败', blocked: '依赖阻塞' };

/** Fast file feedback only. The server performs the complete contract and evidence validation. */
export function parseIntakeUpload(text: string, projectCode: string): IntakeBundle {
  if (new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) throw new Error(t('候选文件不能超过 10 MiB。'));
  let bundle: IntakeBundle;
  try { bundle = JSON.parse(text) as IntakeBundle; } catch { throw new Error(t('请选择有效的 JSON 候选文件。')); }
  if (!bundle || bundle.schema_version !== 1 || !Array.isArray(bundle.items) || !bundle.items.length || bundle.items.length > 500 || !bundle.source || typeof bundle.namespace !== 'string') throw new Error(t('候选格式不正确，请使用 tsp intake validate 检查。'));
  if (bundle.project_code !== projectCode) throw new Error(t('候选文件不属于当前项目。'));
  return bundle;
}

export function intakeItemCommitted(view: IntakeItemView): boolean { return view.status === 'applied' || view.status === 'bound'; }

/** No implicit approvals: every remaining item needs an explicit choice and valid dependencies. */
export function intakeReviewProblem(batch: IntakeBatchDetail, decisions: Record<string, IntakeDecision>): string | null {
  for (const view of batch.items) {
    if (intakeItemCommitted(view)) continue;
    const decision = decisions[view.item.key];
    if (!decision) return t('请逐项选择新增、关联或跳过，再冻结发布计划。');
    if (decision.action === 'bind' && !batch.targets.some(target => target.kind === view.item.kind && target.code === decision.target_code && target.fingerprint === decision.target_fingerprint)) return t('关联目标已变化或尚未选择，请重新核对。');
    if (decision.action === 'create' && view.existing_binding) return t('此来源已有映射，请关联现有实体或跳过。');
    if (decision.action !== 'skip') {
      for (const key of [view.item.module_key, view.item.feature_key, view.item.document_key].filter(Boolean) as string[]) {
        const parent = batch.items.find(entry => entry.item.key === key);
        if (!parent || (!intakeItemCommitted(parent) && (!decisions[key] || decisions[key].action === 'skip'))) return t('依赖项未批准，请先审阅父模块、Feature 或文档。');
      }
    }
  }
  return null;
}

export function intakeCanPublish(batch: IntakeBatchDetail, editing: boolean): boolean {
  return batch.can_review && !editing && Boolean(batch.plan_hash) && ['ready', 'partial', 'stopped'].includes(batch.status);
}

export function filterIntakeItems(items: IntakeItemView[], kind: string, status: string, search: string): IntakeItemView[] {
  const query = search.trim().toLocaleLowerCase();
  return items.filter(view => (!kind || view.item.kind === kind)
    && (!status || (status === 'conflict' ? ['failed', 'blocked'].includes(view.status) || Boolean(view.existing_binding && !intakeItemCommitted(view)) : status === 'applied' ? intakeItemCommitted(view) : view.status === status))
    && (!query || [view.item.title, view.item.summary, view.item.key].some(value => value.toLocaleLowerCase().includes(query))));
}
