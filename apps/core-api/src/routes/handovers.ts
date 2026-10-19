import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHandoverUseCases, resolveSessionToken } from '@team-synergy/application';
import { HandoverSummarySchema, WorkspaceManifestSchema, PublicCodeSchema } from '@team-synergy/contracts';
import type { Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

/** Only middleware-resolved credentials can bind a device or an execution lease. */
export async function executionIdentity(request: FastifyRequest, db: Db) {
  const token = request.authDeviceToken;
  const device = token ? (await resolveSessionToken(db, token))?.device : undefined;
  const epoch = request.headers['x-execution-epoch'];
  const lease = request.headers['x-run-lease'];
  return {
    principalCode: request.principal ?? '',
    authKind: request.authKind ?? undefined,
    deviceCode: device?.code,
    executionEpoch: typeof epoch === 'string' && /^\d+$/.test(epoch) && Number.isSafeInteger(Number(epoch)) ? Number(epoch) : undefined,
    leaseToken: typeof lease === 'string' ? lease : undefined,
  };
}

const invalid = (message: string) => ({ ok: false as const, error: { code: 'validation_failed', message } });
type Body = Record<string, unknown>;
type Validator = (value: unknown) => boolean;
const code: Validator = (value) => PublicCodeSchema.safeParse(value).success;
const text: Validator = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const integer: Validator = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optional = (validate: Validator): Validator => (value) => value === undefined || validate(value);
const hash: Validator = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bodyShapes: Record<string, Record<string, Validator>> = {
  prepare: { target_user_code: code, source_run_code: code, base_snapshot: integer },
  draft: { summary: (value) => HandoverSummarySchema.safeParse(value).success, workspace_manifest: (value) => WorkspaceManifestSchema.safeParse(value).success, preparation_grant: text, version: optional(integer) },
  'stop-ack': { preparation_grant: text, stopped: (value) => value === true, assurance: (value) => ['client_reported', 'supervised', 'manual_confirmation', 'managed_process'].includes(String(value)) },
  publish: { version: optional(integer) },
  accept: { version: optional(integer) },
  restore: { version: optional(integer), workspace_path: optional(text), git_base: optional(text) },
  ready: { version: optional(integer), attempt_code: code, workspace_digest: hash, snapshot_commit: (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value), context_snapshot_hash: hash, assurance: (value) => value === 'client_reported' },
  activate: { version: optional(integer), attempt_code: code, context_snapshot_hash: hash },
  cancel: { version: optional(integer) },
  'approve-drift': { reason: text },
  resume: {},
};

function validateBody(value: unknown, action: string): Body | null {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) return null;
  const body = (value ?? {}) as Body;
  const shape = bodyShapes[action];
  if (!shape || Object.keys(body).some((key) => !(key in shape))) return null;
  if (Object.entries(shape).some(([key, validate]) => !validate(body[key]))) return null;
  return body;
}

export function registerHandoverRoutes(app: FastifyInstance, db: Db): void {
  const uc = createHandoverUseCases(db);
  app.get<{ Params: { project_code: string } }>('/projects/:project_code/handovers', async (request) => {
    if (!code(request.params.project_code)) return invalid('项目编码无效');
    return uc.listProject({ project_code: request.params.project_code, identity: await executionIdentity(request, db) });
  });
  app.get<{ Params: { task_code: string } }>('/tasks/:task_code/handovers', async (request) => {
    if (!code(request.params.task_code)) return invalid('任务编码无效');
    return uc.list({ task_code: request.params.task_code, identity: await executionIdentity(request, db) });
  });
  app.get<{ Params: { handover_code: string } }>('/handovers/:handover_code', async (request) => {
    if (!code(request.params.handover_code)) return invalid('交接编码无效');
    return uc.get({ handover_code: request.params.handover_code, identity: await executionIdentity(request, db) });
  });
  app.get<{ Params: { snapshot_code: string } }>('/context-snapshots/:snapshot_code', async (request) => {
    if (!code(request.params.snapshot_code)) return invalid('上下文快照编码无效');
    return uc.getContext({ snapshot_code: request.params.snapshot_code, identity: await executionIdentity(request, db) });
  });
  app.get<{ Params: { snapshot_code: string } }>('/context-snapshots/:snapshot_code/diff', async (request) => {
    if (!code(request.params.snapshot_code)) return invalid('上下文快照编码无效');
    return uc.diffContext({ snapshot_code: request.params.snapshot_code, identity: await executionIdentity(request, db) });
  });

  app.post<{ Params: { task_code: string }; Body: Body }>('/tasks/:task_code/handovers/prepare', async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    const key = idempotencyKey(request);
    if (key === null) return invalid('幂等键必须为非空字符串且不超过 128 个字符');
    const body = validateBody(request.body, 'prepare');
    if (!code(request.params.task_code) || !body) return invalid('交接准备参数无效');
    return uc.prepare({ task_code: request.params.task_code, source_run_code: String(body.source_run_code),
      target_user_code: String(body.target_user_code), base_snapshot: Number(body.base_snapshot),
      identity: await executionIdentity(request, db), idempotencyKey: key });
  });
  const methods = { draft: 'draft', 'stop-ack': 'ackStop', 'source-stop-ack': 'ackStop', publish: 'publish', accept: 'accept', restore: 'restore', ready: 'ready', activate: 'activate', cancel: 'cancel', 'approve-drift': 'approveDrift' } as const;
  for (const [action, method] of Object.entries(methods)) {
    app.route<{ Params: { handover_code: string }; Body: Body }>({
      method: action === 'draft' ? ['PUT', 'POST'] : 'POST',
      url: `/handovers/:handover_code/${action}`,
      handler: async (request, reply) => {
      if (request.authKind !== 'bearer') return unauthorized(reply);
      const key = idempotencyKey(request);
      if (key === null) return invalid('幂等键必须为非空字符串且不超过 128 个字符');
      const body = validateBody(request.body, action === 'source-stop-ack' ? 'stop-ack' : action);
      if (!code(request.params.handover_code) || !body) return invalid('交接参数无效，身份和设备必须来自认证凭据');
      const common = { handover_code: request.params.handover_code, identity: await executionIdentity(request, db),
        idempotencyKey: key, version: typeof body.version === 'number' ? body.version : undefined };
      switch (method) {
        case 'draft': return uc.draft({ ...common, summary: body.summary, workspace_manifest: body.workspace_manifest, preparation_grant: String(body.preparation_grant) });
        case 'ackStop': return uc.ackStop({ ...common, preparation_grant: String(body.preparation_grant), stopped: body.stopped === true, assurance: String(body.assurance) });
        case 'restore': return uc.restore({ ...common, workspace_path: typeof body.workspace_path === 'string' ? body.workspace_path : undefined, git_base: typeof body.git_base === 'string' ? body.git_base : undefined });
        case 'ready': return uc.ready({ ...common, attempt_code: String(body.attempt_code), workspace_digest: String(body.workspace_digest), snapshot_commit: String(body.snapshot_commit), context_snapshot_hash: String(body.context_snapshot_hash), assurance: String(body.assurance) });
        case 'activate': return uc.activate({ ...common, attempt_code: String(body.attempt_code), context_snapshot_hash: String(body.context_snapshot_hash) });
        case 'approveDrift': return uc.approveDrift({ ...common, reason: String(body.reason) });
        default: return uc[method](common);
      }
      },
    });
  }
  app.post<{ Params: { run_code: string }; Body: Body }>('/runs/:run_code/resume', async (request, reply) => {
    if (request.authKind !== 'bearer') return unauthorized(reply);
    const key = idempotencyKey(request);
    if (key === null) return invalid('幂等键必须为非空字符串且不超过 128 个字符');
    const body = validateBody(request.body, 'resume');
    if (!code(request.params.run_code) || !body) return invalid('恢复参数无效');
    return uc.resume({ run_code: request.params.run_code, identity: await executionIdentity(request, db), idempotencyKey: key });
  });
}

function idempotencyKey(request: FastifyRequest): string | undefined | null {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 ? value : null;
}
