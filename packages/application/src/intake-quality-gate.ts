import { INTAKE_QUALITY_RULE_VERSION, evaluateIntakeQuality, type IntakeBundle, type IntakeQualityGate, type IntakeQualityReport } from '@team-synergy/contracts';
import { intakeHash } from './intake-targets.js';

export interface IntakeQualityBasis {
  profile: IntakeBundle['profile'] | null; quality_rule_version: string | null;
  quality_report_json: string | null; frozen_quality_json: string | null; payload_hash: string; revision: number; plan_hash: string | null;
}
interface FrozenQuality {
  profile: IntakeBundle['profile']; rule_version: string; payload_hash: string;
  report_hash: string; plan_revision: number;
}
export function evaluateBatchQuality(bundle: IntakeBundle, revision: number, payloadHash = intakeHash(bundle)): IntakeQualityReport {
  return evaluateIntakeQuality(bundle, { batch_revision: revision, payload_hash: payloadHash });
}
export function qualityFields(bundle: IntakeBundle, revision: number, payloadHash = intakeHash(bundle)) {
  const report = evaluateBatchQuality(bundle, revision, payloadHash);
  return { profile: bundle.profile, quality_rule_version: report.rule_version, quality_report_json: JSON.stringify(report) };
}
function reportFingerprint(report: IntakeQualityReport): string {
  // Stop/review revisions are governance changes; content and profile remain bound by payload_hash.
  const { batch_revision: _revision, ...material } = report;
  return intakeHash(material);
}
function parsedReport(batch: IntakeQualityBasis): IntakeQualityReport | null {
  if (!batch.quality_report_json) return null;
  try {
    const report = JSON.parse(batch.quality_report_json) as IntakeQualityReport;
    return report && Array.isArray(report.issues) && report.summary && report.artifacts && typeof report.rule_version === 'string' ? report : null;
  } catch { return null; }
}
export function qualityState(batch: IntakeQualityBasis, bundle: IntakeBundle | null): { report: IntakeQualityReport | null; gate: IntakeQualityGate } {
  const report = parsedReport(batch);
  const counts = report ? report.summary : { blockers: 0, warnings: 0, needs_review: 0 };
  if (!batch.profile || !bundle) return { report: null, gate: { status: 'unknown', ...counts, note: '历史批次未记录档位与质量依据；冻结新计划前须明确选择档位。' } };
  const expected = evaluateBatchQuality(bundle, batch.revision, batch.payload_hash);
  if (intakeHash(bundle) !== batch.payload_hash || batch.quality_rule_version !== INTAKE_QUALITY_RULE_VERSION || !report || intakeHash(report) !== intakeHash(expected)) {
    return { report, gate: { status: 'stale', ...counts, note: '候选内容、修订或规则依据已变化，请重新审阅并冻结计划。' } };
  }
  const blocked = bundle.profile === 'enterprise' && report.summary.blockers > 0;
  return { report, gate: { status: blocked ? 'blocked' : 'eligible', ...counts,
    note: blocked ? '企业档位存在阻断问题；草稿可保存，修复后才能冻结新计划。' : '规则门禁允许冻结；不代表内容语义已核验、负责人批准或企业资料已完整发布。' } };
}
export function frozenQuality(bundle: IntakeBundle, report: IntakeQualityReport, planRevision: number): FrozenQuality {
  return { profile: bundle.profile, rule_version: report.rule_version, payload_hash: intakeHash(bundle), report_hash: reportFingerprint(report), plan_revision: planRevision };
}
export function intakePlanHash(batchCode: string, revision: number, payloadHash: string, decisions: unknown[], frozen: FrozenQuality): string {
  return intakeHash({ batch: batchCode, revision, payload: payloadHash, decisions, quality: frozen });
}
export function frozenQualityMatches(batch: IntakeQualityBasis & { code: string }, bundle: IntakeBundle, decisions: unknown[], options = { recheckRules: true }): boolean {
  const report = parsedReport(batch);
  if (!report || !batch.frozen_quality_json || batch.profile !== bundle.profile || intakeHash(bundle) !== batch.payload_hash
    || batch.quality_rule_version !== INTAKE_QUALITY_RULE_VERSION || report.rule_version !== INTAKE_QUALITY_RULE_VERSION
    || report.profile !== bundle.profile || report.payload_hash !== batch.payload_hash || report.batch_revision !== batch.revision
    || (bundle.profile === 'enterprise' && report.summary.blockers > 0)) return false;
  if (options.recheckRules && intakeHash(report) !== intakeHash(evaluateBatchQuality(bundle, batch.revision, batch.payload_hash))) return false;
  try {
    const frozen = JSON.parse(batch.frozen_quality_json) as FrozenQuality;
    if (!Number.isInteger(frozen.plan_revision) || frozen.plan_revision < 1) return false;
    const expected = frozenQuality(bundle, report, frozen.plan_revision);
    return intakeHash(frozen) === intakeHash(expected) && intakePlanHash(batch.code, frozen.plan_revision, batch.payload_hash, decisions, frozen) === batch.plan_hash;
  } catch { return false; }
}
