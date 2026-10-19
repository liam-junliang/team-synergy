import { DomainError } from '@team-synergy/domain';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function normalizeScheduleDate(value: string | null | undefined, field: string): string | null {
  const normalized = value?.trim() || null;
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!ISO_DATE_PATTERN.test(normalized) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new DomainError('schedule_date_invalid', `${field} 必须是有效的 YYYY-MM-DD 日期`, { field, value: normalized });
  }
  return normalized;
}

export function assertScheduleOrder(startDate: string | null, endDate: string | null, entity: 'phase' | 'milestone' | 'feature') {
  if (startDate && endDate && endDate < startDate) {
    throw new DomainError(`${entity}_date_range_invalid`, '结束日期不能早于开始日期', {
      start_date: startDate,
      end_date: endDate,
    });
  }
}

export function assertFeatureScheduleWithinMilestone(
  startDate: string | null,
  endDate: string | null,
  milestone?: { code: string; start_date: string | null; target_date: string | null },
) {
  if (!startDate && !endDate) return;
  if (!startDate || !endDate) {
    throw new DomainError('feature_schedule_incomplete', 'Feature 排期必须同时填写开始日期和结束日期', {
      start_date: startDate,
      end_date: endDate,
    });
  }
  assertScheduleOrder(startDate, endDate, 'feature');
  if (!milestone) {
    throw new DomainError('feature_schedule_requires_milestone', 'Feature 安排日期前必须先选择目标里程碑');
  }
  if (!milestone.start_date || !milestone.target_date) {
    throw new DomainError('feature_milestone_schedule_required', '目标里程碑必须先设置完整的开始日期和目标日期', {
      milestone_code: milestone.code,
    });
  }
  if (startDate < milestone.start_date || endDate > milestone.target_date) {
    throw new DomainError('feature_schedule_outside_milestone', 'Feature 排期必须落在目标里程碑日期范围内', {
      milestone_code: milestone.code,
      milestone_start_date: milestone.start_date,
      milestone_target_date: milestone.target_date,
      start_date: startDate,
      end_date: endDate,
    });
  }
}
