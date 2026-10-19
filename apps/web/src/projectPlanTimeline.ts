import { translate, formatDate, getLocale, type Locale } from './i18n.ts';
import type { Feature, ProjectMilestone, ProjectPhase } from './api';

export const TIMELINE_DAY_WIDTH = 28;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMELINE_BUFFER_DAYS = 7;

export interface TimelineRange {
  start: Date;
  end: Date;
  startKey: string;
  endKey: string;
  dayCount: number;
  totalWidth: number;
  todayIndex: number;
  monthBands: Array<{ key: string; label: string; startIndex: number; span: number }>;
  weekBands: Array<{ key: string; label: string; startIndex: number; span: number; isMonthStart: boolean }>;
}

export interface PhaseTimelineGroup {
  key: string;
  phase: ProjectPhase | null;
  milestones: Array<ProjectMilestone & { features: Feature[] }>;
}

export function parseTimelineDate(value?: string | null): Date | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().slice(0, 10);
  const parsed = new Date(`${normalized}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatTimelineDate(value?: string | null, locale: Locale = getLocale()): string {
  const parsed = parseTimelineDate(value);
  if (!parsed) return translate(locale, '未排期');
  return formatDate(parsed, { month: 'numeric', day: 'numeric' }, locale);
}

export function formatTimelineSpan(start?: string | null, end?: string | null, locale: Locale = getLocale()): string {
  if (!start && !end) return translate(locale, '未排期');
  if (start && end) return `${formatTimelineDate(start, locale)} - ${formatTimelineDate(end, locale)}`;
  return formatTimelineDate(start ?? end, locale);
}

export function buildPhaseTimelineGroups(phases: ProjectPhase[], milestones: ProjectMilestone[], features: Feature[]): PhaseTimelineGroup[] {
  const featuresByMilestone = new Map<string, Feature[]>();
  features.forEach((feature) => {
    if (!feature.milestone_code) return;
    const current = featuresByMilestone.get(feature.milestone_code) ?? [];
    current.push(feature);
    featuresByMilestone.set(feature.milestone_code, current);
  });

  const phaseOrder = new Map(phases.map((phase, index) => [phase.code, index]));
  const grouped = phases.map<PhaseTimelineGroup>((phase) => ({
    key: phase.code,
    phase,
    milestones: milestones
      .filter((milestone) => milestone.phase_code === phase.code)
      .sort(sortByOrderThenName)
      .map((milestone) => ({ ...milestone, features: (featuresByMilestone.get(milestone.code) ?? []).slice().sort(sortByFeatureName) })),
  }));

  const looseMilestones = milestones
    .filter((milestone) => !milestone.phase_code || !phaseOrder.has(milestone.phase_code))
    .sort(sortByOrderThenName)
    .map((milestone) => ({ ...milestone, features: (featuresByMilestone.get(milestone.code) ?? []).slice().sort(sortByFeatureName) }));

  if (looseMilestones.length > 0) {
    grouped.push({
      key: 'unassigned-phase',
      phase: null,
      milestones: looseMilestones,
    });
  }

  return grouped;
}

export function deriveTimelineRange(phases: ProjectPhase[], milestones: ProjectMilestone[], now = new Date(), locale: Locale = getLocale()): TimelineRange {
  const scheduledDates = [
    ...phases.flatMap((phase) => [parseTimelineDate(phase.start_at), parseTimelineDate(phase.end_at)]),
    ...milestones.flatMap((milestone) => [parseTimelineDate(milestone.start_at), parseTimelineDate(milestone.target_at)]),
  ].filter((value): value is Date => Boolean(value));

  const start = scheduledDates.length > 0
    ? shiftDate(startOfDay(new Date(Math.min(...scheduledDates.map((date) => date.getTime())))), -TIMELINE_BUFFER_DAYS)
    : shiftDate(startOfQuarter(now), -TIMELINE_BUFFER_DAYS);
  const end = scheduledDates.length > 0
    ? shiftDate(startOfDay(new Date(Math.max(...scheduledDates.map((date) => date.getTime())))), TIMELINE_BUFFER_DAYS)
    : shiftDate(endOfQuarter(now), TIMELINE_BUFFER_DAYS);

  const normalizedStart = startOfDay(start);
  const normalizedEnd = startOfDay(end);
  const dayCount = Math.max(1, diffDays(normalizedStart, normalizedEnd) + 1);
  const monthBands = buildMonthBands(normalizedStart, dayCount, locale);
  const weekBands = buildWeekBands(normalizedStart, dayCount, locale);
  const todayIndex = clamp(diffDays(normalizedStart, startOfDay(now)), 0, dayCount - 1);

  return {
    start: normalizedStart,
    end: normalizedEnd,
    startKey: toDateKey(normalizedStart),
    endKey: toDateKey(normalizedEnd),
    dayCount,
    totalWidth: dayCount * TIMELINE_DAY_WIDTH,
    todayIndex,
    monthBands,
    weekBands,
  };
}

export function buildBarMetrics(range: TimelineRange, start?: string | null, end?: string | null): { left: number; width: number } | null {
  const startDate = parseTimelineDate(start);
  const endDate = parseTimelineDate(end);
  if (!startDate && !endDate) return null;
  const from = startDate ?? endDate;
  const to = endDate ?? startDate;
  if (!from || !to) return null;
  const leftIndex = clamp(diffDays(range.start, from), 0, range.dayCount - 1);
  const rightIndex = clamp(diffDays(range.start, to), leftIndex, range.dayCount - 1);
  return {
    left: leftIndex * TIMELINE_DAY_WIDTH,
    width: Math.max(TIMELINE_DAY_WIDTH, (rightIndex - leftIndex + 1) * TIMELINE_DAY_WIDTH),
  };
}

export function buildMarkerPosition(range: TimelineRange, value?: string | null): number | null {
  const date = parseTimelineDate(value);
  if (!date) return null;
  const index = clamp(diffDays(range.start, date), 0, range.dayCount - 1);
  return index * TIMELINE_DAY_WIDTH + TIMELINE_DAY_WIDTH / 2;
}

function buildMonthBands(start: Date, dayCount: number, locale: Locale): TimelineRange['monthBands'] {
  const bands: TimelineRange['monthBands'] = [];
  for (let index = 0; index < dayCount;) {
    const current = shiftDate(start, index);
    const key = `${current.getFullYear()}-${current.getMonth() + 1}`;
    const month = current.getMonth();
    const year = current.getFullYear();
    let span = 0;
    while (index + span < dayCount) {
      const probe = shiftDate(start, index + span);
      if (probe.getMonth() !== month || probe.getFullYear() !== year) break;
      span += 1;
    }
    bands.push({
      key,
      label: formatDate(current, { month: 'long' }, locale),
      startIndex: index,
      span,
    });
    index += span;
  }
  return bands;
}

function buildWeekBands(start: Date, dayCount: number, locale: Locale): TimelineRange['weekBands'] {
  const bands: TimelineRange['weekBands'] = [];
  for (let index = 0; index < dayCount; index += 7) {
    const current = shiftDate(start, index);
    const span = Math.min(7, dayCount - index);
    bands.push({
      key: `${toDateKey(current)}-${span}`,
      label: formatDate(current, { month: 'numeric', day: 'numeric' }, locale),
      startIndex: index,
      span,
      isMonthStart: current.getDate() <= 7,
    });
  }
  return bands;
}

function startOfQuarter(now: Date): Date {
  const month = now.getMonth();
  const quarterMonth = Math.floor(month / 3) * 3;
  return new Date(now.getFullYear(), quarterMonth, 1);
}

function endOfQuarter(now: Date): Date {
  const start = startOfQuarter(now);
  return new Date(start.getFullYear(), start.getMonth() + 3, 0);
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function shiftDate(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function diffDays(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

function toDateKey(value: Date): string {
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sortByOrderThenName<T extends { order?: number; name?: string }>(left: T, right: T): number {
  const order = (left.order ?? 0) - (right.order ?? 0);
  if (order !== 0) return order;
  return (left.name ?? '').localeCompare(right.name ?? '', getLocale());
}

function sortByFeatureName(left: Feature, right: Feature): number {
  return left.title.localeCompare(right.title, getLocale());
}
