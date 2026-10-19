import { translate, getLocale, type Locale } from './i18n.ts';
import type { ITask } from '@svar-ui/react-gantt';
import type { Feature, ProjectMilestone, ProjectPhase } from './api';
import { buildPhaseTimelineGroups, formatTimelineSpan, parseTimelineDate } from './projectPlanTimeline';

export type PlanEntityKind = 'phase' | 'milestone' | 'feature';

export interface PlanGanttTask extends ITask {
  id: string;
  code: string;
  entityKind: PlanEntityKind;
  statusLabel: string;
  scheduleLabel: string;
}

export interface PlanGanttBuildOptions {
  locale?: Locale;
  phaseCode?: string | null;
  search?: string;
}

export function buildPlanGanttTasks(
  phases: ProjectPhase[],
  milestones: ProjectMilestone[],
  features: Feature[],
  options: PlanGanttBuildOptions = {},
): PlanGanttTask[] {
  const locale = options.locale ?? getLocale();
  const search = options.search?.trim().toLocaleLowerCase() ?? '';
  const groups = buildPhaseTimelineGroups(phases, milestones, features);
  const result: PlanGanttTask[] = [];

  for (const group of groups) {
    if (options.phaseCode && group.phase?.code !== options.phaseCode) continue;

    const groupMatches = matchesSearch(search, [
      group.phase?.name,
      group.phase?.summary,
      group.phase?.code,
    ]);
    const matchingMilestones = group.milestones.filter((milestone) => groupMatches || matchesSearch(search, [
      milestone.name,
      milestone.summary,
      milestone.code,
      milestone.phase_name,
      ...milestone.features.flatMap((feature) => [feature.title, feature.goal, feature.code, feature.module_name, feature.module_code]),
    ]));

    if (search && !groupMatches && matchingMilestones.length === 0) continue;

    const phase = group.phase;
    const phaseId = phase ? ganttTaskId('phase', phase.code) : 'phase:unassigned';
    const phaseSpan = resolvePhaseSpan(phase, matchingMilestones);
    result.push({
      id: phaseId,
      code: phase?.code ?? 'unassigned',
      entityKind: 'phase',
      text: phase?.name ?? translate(locale, '未归属阶段'),
      details: phase?.summary ?? '',
      type: 'phase',
      parent: 0,
      open: matchingMilestones.length > 0,
      progress: statusProgress(phase?.status),
      statusLabel: phase ? phaseStatusLabel(phase.status, locale) : translate(locale, '待归属'),
      scheduleLabel: phaseSpan ? formatTimelineSpan(toDateKey(phaseSpan.start), toDateKey(phaseSpan.end), locale) : translate(locale, '未排期'),
      ...toTaskSchedule(phaseSpan),
    });

    for (const milestone of matchingMilestones) {
      const milestoneId = ganttTaskId('milestone', milestone.code);
      const milestoneSpan = normalizeSpan(milestone.start_at, milestone.target_at);
      result.push({
        id: milestoneId,
        code: milestone.code,
        entityKind: 'milestone',
        parent: phaseId,
        text: milestone.name,
        details: milestone.summary ?? '',
        type: 'milestone-group',
        open: milestone.features.length > 0,
        progress: statusProgress(milestone.status),
        statusLabel: milestoneStatusLabel(milestone.status, locale),
        scheduleLabel: milestoneSpan ? formatTimelineSpan(toDateKey(milestoneSpan.start), toDateKey(milestoneSpan.end), locale) : translate(locale, '未排期'),
        ...toTaskSchedule(milestoneSpan),
      });

      for (const feature of milestone.features) {
        if (search && !groupMatches && !matchesSearch(search, [
          milestone.name,
          milestone.summary,
          milestone.code,
          feature.title,
          feature.goal,
          feature.code,
          feature.module_name,
          feature.module_code,
        ])) continue;

        const featureSpan = normalizeSpan(feature.start_at, feature.end_at);
        result.push({
          id: ganttTaskId('feature', feature.code),
          code: feature.code,
          entityKind: 'feature',
          parent: milestoneId,
          text: feature.title,
          details: feature.goal ?? '',
          type: 'feature',
          progress: statusProgress(feature.status),
          statusLabel: featureStatusLabel(feature.status, locale),
          scheduleLabel: featureSpan ? formatTimelineSpan(toDateKey(featureSpan.start), toDateKey(featureSpan.end), locale) : translate(locale, '待安排'),
          ...toTaskSchedule(featureSpan),
        });
      }
    }
  }

  return result;
}

export function ganttTaskId(kind: PlanEntityKind, code: string): string {
  return `${kind}:${code}`;
}

export function decodeGanttDomTaskId(id?: string | null): string | null {
  if (!id) return null;
  return id.startsWith(':') ? id.slice(1) : id;
}

export function parseGanttTaskId(id?: string | number | null): { kind: PlanEntityKind; code: string } | null {
  if (typeof id !== 'string') return null;
  const separator = id.indexOf(':');
  if (separator <= 0) return null;
  const kind = id.slice(0, separator);
  if (kind !== 'phase' && kind !== 'milestone' && kind !== 'feature') return null;
  return { kind, code: id.slice(separator + 1) };
}

function resolvePhaseSpan(
  phase: ProjectPhase | null,
  milestones: Array<ProjectMilestone & { features: Feature[] }>,
): { start: Date; end: Date } | null {
  const direct = normalizeSpan(phase?.start_at, phase?.end_at);
  if (direct) return direct;
  const childDates = milestones.flatMap((milestone) => [
    parseTimelineDate(milestone.start_at),
    parseTimelineDate(milestone.target_at),
  ]).filter((value): value is Date => Boolean(value));
  if (childDates.length === 0) return null;
  return {
    start: new Date(Math.min(...childDates.map((date) => date.getTime()))),
    end: new Date(Math.max(...childDates.map((date) => date.getTime()))),
  };
}

function normalizeSpan(startValue?: string | null, endValue?: string | null): { start: Date; end: Date } | null {
  const start = parseTimelineDate(startValue);
  const end = parseTimelineDate(endValue);
  if (!start && !end) return null;
  const from = start ?? end;
  const to = end ?? start;
  if (!from || !to) return null;
  return from.getTime() <= to.getTime() ? { start: from, end: to } : { start: to, end: from };
}

function toTaskSchedule(span: { start: Date; end: Date } | null): Pick<PlanGanttTask, 'start' | 'end' | 'duration' | 'unscheduled'> {
  if (!span) return { unscheduled: true };
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    start: span.start,
    end: span.end,
    duration: Math.max(1, Math.round((span.end.getTime() - span.start.getTime()) / dayMs) + 1),
    unscheduled: false,
  };
}

function matchesSearch(search: string, values: Array<string | null | undefined>): boolean {
  if (!search) return true;
  return values.filter(Boolean).join(' ').toLocaleLowerCase().includes(search);
}

function statusProgress(status?: string | null): number {
  switch (status) {
    case 'completed':
    case 'delivered':
    case 'closed':
      return 100;
    case 'active':
      return 55;
    case 'at_risk':
      return 35;
    case 'archived':
    case 'cancelled':
      return 100;
    default:
      return 12;
  }
}

function phaseStatusLabel(status: string, locale: Locale): string {
  return ({ planned: translate(locale, '规划中'), active: translate(locale, '进行中'), completed: translate(locale, '已完成'), archived: translate(locale, '已归档') } as Record<string, string>)[status] ?? status;
}

function milestoneStatusLabel(status: string, locale: Locale): string {
  return ({ planned: translate(locale, '规划中'), active: translate(locale, '进行中'), at_risk: translate(locale, '有风险'), completed: translate(locale, '已完成'), cancelled: translate(locale, '已取消') } as Record<string, string>)[status] ?? status;
}

function featureStatusLabel(status: string, locale: Locale): string {
  return ({ active: translate(locale, '进行中'), delivered: translate(locale, '已交付'), archived: translate(locale, '已归档') } as Record<string, string>)[status] ?? status;
}

function toDateKey(value: Date): string {
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}
