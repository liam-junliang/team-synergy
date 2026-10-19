import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import {
  FEATURE_STATUSES,
  createMemberUseCases,
  createProjectUseCases,
  createTaskService,
  createTaskBaselineUseCases,
  createVerificationUseCases,
} from '@team-synergy/application';
import { schema, type Db } from '@team-synergy/persistence';
import {
  ArtifactKindSchema,
  EvidenceResultSchema,
  EvidenceTypeSchema,
  ProfileSchema,
  TaskSourceSchema,
  TaskStatusSchema,
  PublicCodeSchema,
} from '@team-synergy/contracts';
import { unauthorized } from '../auth.js';
import { executionIdentity } from './handovers.js';

interface StringEnumSchema<T extends string> {
  options: readonly T[];
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function parseEnum<T extends string>(schema: StringEnumSchema<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function invalidEnumResult(code: string, label: string, value: unknown, valid: readonly string[]) {
  return {
    ok: false as const,
    error: {
      code,
      message: `非法${label}：${String(value ?? '')}`,
      details: { valid },
    },
  };
}

function codeOf(body: Record<string, unknown>, modernKey: string, legacyKey?: string): string {
  const modern = body[modernKey];
  if (typeof modern === 'string' && modern.length > 0) return modern;
  if (!legacyKey) return '';
  const legacy = body[legacyKey];
  return typeof legacy === 'string' ? legacy : '';
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}


export function registerTaskRoutes(app: FastifyInstance, db: Db): void {
  const taskService = createTaskService(db);
  const projectUc = createProjectUseCases(db);
  const verifyUc = createVerificationUseCases(db);
  const memberUc = createMemberUseCases(db);

  app.post<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/baseline', async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    const body = request.body;
    if (!body || Array.isArray(body) || typeof body !== 'object'
      || Object.keys(body).some(key => !['baseline_code', 'base_snapshot'].includes(key))
      || !PublicCodeSchema.safeParse(request.params.task_code).success || !PublicCodeSchema.safeParse(body.baseline_code).success
      || typeof body.base_snapshot !== 'number' || !Number.isSafeInteger(body.base_snapshot) || body.base_snapshot < 0) {
      return { ok: false as const, error: { code: 'validation_failed', message: '基线绑定需要有效编码和任务版本' } };
    }
    return createTaskBaselineUseCases(db).bind({ taskCode: request.params.task_code, baselineCode: String(body.baseline_code),
      baseSnapshot: body.base_snapshot, principalCode: (request.principal ?? '') });
  });

  app.get<{ Querystring: { status?: string; assignee_principal_code?: string; project_code?: string } }>('/tasks', async (request) => {
    const statusRaw = request.query.status;
    const status = statusRaw === undefined ? undefined : parseEnum(TaskStatusSchema, statusRaw);
    if (statusRaw !== undefined && !status) {
      return invalidEnumResult('invalid_status', '任务状态', statusRaw, TaskStatusSchema.options);
    }
    const assignedTo = request.query.assignee_principal_code === 'me'
      ? (request.principal ?? '')
      : request.query.assignee_principal_code;
    return {
      ok: true as const,
      data: await taskService.listTasks({
        status: status ?? undefined,
        assignedTo: assignedTo || undefined,
        projectCode: request.query.project_code,
        principalCode: request.principal ?? '',
      }),
    };
  });

  app.get<{ Querystring: { project_code?: string } }>('/tasks/graph', async (request) => {
    const visibleTasks = await taskService.listTasks({ projectCode: request.query.project_code, principalCode: request.principal ?? '' });
    if (visibleTasks.length === 0) {
      return { ok: true as const, data: { nodes: [], edges: [] } };
    }

    const codes = visibleTasks.map((task) => task.task_code);
    const rows = await db.select({ id: schema.tasks.id, code: schema.tasks.code })
      .from(schema.tasks)
      .where(inArray(schema.tasks.code, codes));
    const taskIdToCode = new Map(rows.map((row) => [row.id, row.code]));
    const taskIds = rows.map((row) => row.id);
    const dependencies = taskIds.length === 0
      ? []
      : await db.select().from(schema.taskDependencies).where(inArray(schema.taskDependencies.task_id, taskIds));

    return {
      ok: true as const,
      data: {
        nodes: visibleTasks.map((task) => ({
          task_code: task.task_code,
          title: task.title,
          status: task.status,
        })),
        edges: dependencies.flatMap((dependency) => {
          const from = taskIdToCode.get(dependency.task_id);
          const to = taskIdToCode.get(dependency.depends_on_task_id);
          return from && to ? [{ from, to }] : [];
        }),
      },
    };
  });

  app.get<{ Params: { task_code: string } }>('/tasks/:task_code/evidences', async (request) => {
    const result = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    return result.ok
      ? { ok: true as const, data: result.data.evidences }
      : result;
  });

  app.get<{ Params: { task_code: string } }>('/tasks/:task_code', async (request, reply) => {
    const result = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    if (result.ok && result.data.requirement_baseline_code) {
      if (request.authKind !== 'bearer') return unauthorized(reply);
    }
    return result;
  });

  app.get<{ Params: { task_code: string } }>('/tasks/:task_code/history', async (request) => ({
    ok: true as const,
    data: await verifyUc.taskHistory(request.params.task_code, request.principal ?? ''),
  }));

  app.post<{ Body: Record<string, unknown> }>('/tasks', async (request, reply) => {
    const body = request.body ?? {};
    if (body.baseline_code !== undefined) {
      if (request.authKind !== 'bearer') return unauthorized(reply);
      if (!PublicCodeSchema.safeParse(body.baseline_code).success) return {
        ok: false as const, error: { code: 'validation_failed', message: '需求基线编码无效' },
      };
    }
    const profile = parseEnum(ProfileSchema, body.profile);
    if (!profile) return invalidEnumResult('invalid_profile', 'Profile', body.profile, ProfileSchema.options);
    const source = parseEnum(TaskSourceSchema, body.source);
    if (!source) return invalidEnumResult('invalid_source', '任务来源', body.source, TaskSourceSchema.options);

    return await projectUc.createTask({
      featureCode: codeOf(body, 'feature_code'),
      title: String(body.title ?? ''),
      brief: typeof body.brief === 'string' ? body.brief : undefined,
      profile,
      source,
      requirementCode: codeOf(body, 'requirement_code') || undefined,
      requirementBaselineCode: codeOf(body, 'baseline_code') || undefined,
      defectCode: codeOf(body, 'defect_code') || undefined,
      acceptance: Array.isArray(body.acceptance) ? body.acceptance as Array<{ id: string; text: string }> : [],
      dependsOnCodes: stringArrayOf(body.depends_on_codes ?? body.depends_on),
      validationSeams: body.validation_seams === undefined ? undefined : stringArrayOf(body.validation_seams),
      scope: typeof body.scope === 'object' && body.scope !== null ? body.scope as { writable_paths: string[] } : undefined,
      principalCode: (request.principal ?? ''),
    });
  });

  app.patch<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/contract', async (request) => {
    const body = request.body ?? {};
    return await taskService.updateTaskContract({
      taskCode: request.params.task_code,
      principalCode: (request.principal ?? ''),
      baseSnapshot: typeof body.base_snapshot === 'number' ? body.base_snapshot : 0,
      title: String(body.title ?? ''),
      brief: typeof body.brief === 'string' ? body.brief : undefined,
      acceptance: Array.isArray(body.acceptance) ? body.acceptance as Array<{ id: string; text: string }> : [],
      validationSeams: body.validation_seams === undefined ? undefined : stringArrayOf(body.validation_seams),
      scope: typeof body.scope === 'object' && body.scope !== null ? body.scope as { writable_paths: string[] } : undefined,
    });
  });

  app.post<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/cancel', async (request) => {
    const body = request.body ?? {};
    const current = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    if (!current.ok) return current;
    return await taskService.cancelTask({
      taskCode: request.params.task_code,
      principalCode: (request.principal ?? ''),
      baseSnapshot: typeof body.base_snapshot === 'number' ? body.base_snapshot : current.data.base_snapshot,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
  });

  app.post<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/assign', async (request) => {
    const body = request.body ?? {};
    const current = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    if (!current.ok) return current;
    return await taskService.assignTask({
      taskCode: request.params.task_code,
      assigneePrincipalCode: codeOf(body, 'assignee_principal_code')
        || codeOf(body, 'user_code'),
      principalCode: (request.principal ?? ''),
      baseSnapshot: typeof body.base_snapshot === 'number' ? body.base_snapshot : current.data.base_snapshot,
    });
  });

  app.post<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/claim', async (request) => {
    const body = request.body ?? {};
    const current = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    if (!current.ok) return current;
    const profile = parseEnum(ProfileSchema, body.profile);
    if (!profile) return invalidEnumResult('invalid_profile', 'Profile', body.profile, ProfileSchema.options);

    return await taskService.claimTask({
      taskCode: request.params.task_code,
      runCode: codeOf(body, 'run_code'),
      workspaceCode: codeOf(body, 'workspace_code'),
      principalCode: (request.principal ?? ''),
      profile,
      baseSnapshot: typeof body.base_snapshot === 'number' ? body.base_snapshot : current.data.base_snapshot,
      workspacePath: String(body.workspace_path ?? ''),
      gitBase: String(body.git_base ?? ''),
    });
  });

  app.post<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/submit', async (request) => {
    const body = request.body ?? {};
    const current = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    if (!current.ok) return current;
    const artifact = body.artifact as { kind?: unknown; uri?: unknown; content_hash?: unknown; contentHash?: unknown } | undefined;
    const evidence = body.evidence as {
      type?: unknown;
      result?: unknown;
      acceptance_refs?: unknown;
      acceptanceRefs?: unknown;
      command?: unknown;
      summary?: unknown;
    } | undefined;
    const artifactKind = parseEnum(ArtifactKindSchema, artifact?.kind);
    if (!artifactKind) return invalidEnumResult('invalid_artifact_kind', 'Artifact 类型', artifact?.kind, ArtifactKindSchema.options);
    const evidenceType = parseEnum(EvidenceTypeSchema, evidence?.type);
    if (!evidenceType) return invalidEnumResult('invalid_evidence_type', 'Evidence 类型', evidence?.type, EvidenceTypeSchema.options);
    const evidenceResult = parseEnum(EvidenceResultSchema, evidence?.result);
    if (!evidenceResult) return invalidEnumResult('invalid_evidence_result', 'Evidence 结果', evidence?.result, EvidenceResultSchema.options);

    return await taskService.submitTask({
      ...await executionIdentity(request, db),
      taskCode: request.params.task_code,
      runCode: codeOf(body, 'run_code'),
      principalCode: (request.principal ?? ''),
      baseSnapshot: typeof body.base_snapshot === 'number' ? body.base_snapshot : current.data.base_snapshot,
      artifact: {
        kind: artifactKind,
        uri: String(artifact?.uri ?? ''),
        contentHash: String(artifact?.content_hash ?? artifact?.contentHash ?? ''),
      },
      evidence: {
        type: evidenceType,
        result: evidenceResult,
        acceptanceRefs: stringArrayOf(evidence?.acceptance_refs ?? evidence?.acceptanceRefs),
        command: typeof evidence?.command === 'string' ? evidence.command : undefined,
        summary: typeof evidence?.summary === 'string' ? evidence.summary : undefined,
      },
    });
  });

  app.post<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/verify', async (request) => {
    const body = request.body ?? {};
    const current = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    if (!current.ok) return current;
    const evidence = body.evidence as { result?: unknown; acceptance_refs?: unknown; acceptanceRefs?: unknown; command?: unknown; summary?: unknown } | undefined;
    const evidenceResult = parseEnum(EvidenceResultSchema, evidence?.result);
    if (!evidenceResult) return invalidEnumResult('invalid_evidence_result', 'Evidence 结果', evidence?.result, EvidenceResultSchema.options);

    return await verifyUc.verifyTask({
      ...await executionIdentity(request, db),
      taskCode: request.params.task_code,
      runCode: codeOf(body, 'run_code'),
      principalCode: (request.principal ?? ''),
      baseSnapshot: typeof body.base_snapshot === 'number' ? body.base_snapshot : current.data.base_snapshot,
      evidence: {
        type: 'verifier_review',
        result: evidenceResult,
        acceptanceRefs: stringArrayOf(evidence?.acceptance_refs ?? evidence?.acceptanceRefs),
        command: typeof evidence?.command === 'string' ? evidence.command : undefined,
        summary: typeof evidence?.summary === 'string' ? evidence.summary : undefined,
      },
    });
  });

  app.post<{ Params: { task_code: string }; Body: Record<string, unknown> }>('/tasks/:task_code/close', async (request) => {
    const body = request.body ?? {};
    const current = await taskService.getTaskStatus(request.params.task_code, request.principal ?? '');
    if (!current.ok) return current;
    return await verifyUc.closeTask({
      taskCode: request.params.task_code,
      principalCode: (request.principal ?? ''),
      baseSnapshot: typeof body.base_snapshot === 'number' ? body.base_snapshot : current.data.base_snapshot,
    });
  });

  app.get<{ Querystring: { project_code?: string } }>('/members', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    if (!request.query.project_code) return { ok: false as const, error: { code: 'project_code_required', message: '读取成员必须指定项目' } };
    return { ok: true as const, data: await memberUc.listMembers(request.query.project_code, request.principal) };
  });

  app.get<{ Querystring: { project_code?: string } }>('/features', async (request) => {
    if (!request.query.project_code) {
      return { ok: false as const, error: { code: 'project_code_required', message: '读取 Feature 列表必须指定 project_code' } };
    }
    return await projectUc.listFeatures({
      projectCode: request.query.project_code,
      principalCode: (request.principal ?? ''),
    });
  });

  app.put<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/features/order', async (request) => {
    const body = request.body ?? {};
    return await projectUc.reorderFeatures({
      projectCode: request.params.project_code,
      principalCode: (request.principal ?? ''),
      featureCodes: Array.isArray(body.feature_codes) ? body.feature_codes.map(String) : [],
    });
  });

  app.get<{ Params: { feature_code: string } }>('/features/:feature_code', async (request) => (
    await projectUc.getFeature({
      featureCode: request.params.feature_code,
      principalCode: (request.principal ?? ''),
    })
  ));

  app.patch<{ Params: { feature_code: string }; Body: Record<string, unknown> }>('/features/:feature_code', async (request) => {
    const body = request.body ?? {};
    const statusRaw = body.status;
    const status = statusRaw === undefined ? undefined : (
      typeof statusRaw === 'string' && FEATURE_STATUSES.includes(statusRaw as typeof FEATURE_STATUSES[number])
        ? statusRaw as typeof FEATURE_STATUSES[number]
        : null
    );
    if (status === null) {
      return { ok: false as const, error: { code: 'feature_status_invalid', message: `非法 Feature 状态：${String(statusRaw ?? '')}`, details: { valid: FEATURE_STATUSES } } };
    }
    return await projectUc.updateFeature({
      featureCode: request.params.feature_code,
      principalCode: (request.principal ?? ''),
      name: typeof body.name === 'string' ? body.name : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      goal: body.goal === undefined ? undefined : (typeof body.goal === 'string' ? body.goal : null),
      status: status ?? undefined,
      moduleCode: body.module_code === undefined ? undefined : (typeof body.module_code === 'string' && body.module_code.length > 0 ? body.module_code : null),
      milestoneCode: body.milestone_code === undefined ? undefined : (typeof body.milestone_code === 'string' && body.milestone_code.length > 0 ? body.milestone_code : null),
      startDate: body.start_date === undefined ? undefined : (typeof body.start_date === 'string' ? body.start_date : null),
      endDate: body.end_date === undefined ? undefined : (typeof body.end_date === 'string' ? body.end_date : null),
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/features', async (request) => {
    const body = request.body ?? {};
    const statusRaw = body.status;
    const status = statusRaw === undefined ? undefined : (
      typeof statusRaw === 'string' && FEATURE_STATUSES.includes(statusRaw as typeof FEATURE_STATUSES[number])
        ? statusRaw as typeof FEATURE_STATUSES[number]
        : null
    );
    if (status === null) {
      return { ok: false as const, error: { code: 'feature_status_invalid', message: `非法 Feature 状态：${String(statusRaw ?? '')}`, details: { valid: FEATURE_STATUSES } } };
    }
    return await projectUc.createFeature({
      projectCode: codeOf(body, 'project_code'),
      name: typeof body.name === 'string' ? body.name : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      goal: typeof body.goal === 'string' ? body.goal : undefined,
      status: status ?? undefined,
      moduleCode: typeof body.module_code === 'string' ? body.module_code : undefined,
      milestoneCode: typeof body.milestone_code === 'string' ? body.milestone_code : undefined,
      startDate: typeof body.start_date === 'string' ? body.start_date : undefined,
      endDate: typeof body.end_date === 'string' ? body.end_date : undefined,
      principalCode: (request.principal ?? ''),
    });
  });
}

export type { Db };
