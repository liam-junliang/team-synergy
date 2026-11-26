import type { FastifyInstance } from 'fastify';
import { createTaskWebDelivery, createTaskWebExecution, fail, listTaskWebBoard } from '@team-synergy/application';
import { PublicCodeSchema, TaskWebWorkflowCommandSchema } from '@team-synergy/contracts';
import type { Db } from '@team-synergy/persistence';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';

function invalid(message: string) {
  return { ok: false as const, error: { code: 'validation_failed', message } };
}

export function registerTaskWebWorkflowRoutes(app: FastifyInstance, db: Db): void {
  const execution = createTaskWebExecution(db);
  const delivery = createTaskWebDelivery(db);
  app.get<{ Params: { project_code: string } }>('/projects/:project_code/task-workflow', async (request, reply) => {
    if (!hasAuthenticatedSession(request)) return unauthorized(reply);
    const code = PublicCodeSchema.safeParse(request.params.project_code);
    if (!code.success) return invalid('需要有效的项目编码');
    reply.header('Cache-Control', 'no-store');
    try {
      return { ok: true as const, data: await listTaskWebBoard(db, code.data, request.principal ?? '') };
    } catch (error) { return fail(error); }
  });
  app.get<{ Params: { task_code: string } }>('/tasks/:task_code/web-workflow', async (request, reply) => {
    if (!hasAuthenticatedSession(request)) return unauthorized(reply);
    const code = PublicCodeSchema.safeParse(request.params.task_code);
    if (!code.success) return invalid('需要有效的任务编码');
    reply.header('Cache-Control', 'no-store');
    const actor = request.principal ?? '';
    try {
      const [executionView, deliveryView] = await Promise.all([
        execution.inspect(code.data, actor), delivery.inspect(code.data, actor),
      ]);
      return { ok: true as const, data: {
        status: executionView.status, base_snapshot: executionView.base_snapshot, execution: executionView, delivery: deliveryView,
      } };
    } catch (error) { return fail(error); }
  });
  app.post<{ Params: { task_code: string }; Body: unknown }>('/tasks/:task_code/web-workflow', { bodyLimit: 32_768 }, async (request, reply) => {
    if (!hasAuthenticatedSession(request) || request.authKind === 'connector') return unauthorized(reply);
    const code = PublicCodeSchema.safeParse(request.params.task_code);
    const command = TaskWebWorkflowCommandSchema.safeParse(request.body);
    if (!code.success) return invalid('需要有效的任务编码');
    if (!command.success) return invalid('请核对任务版本、操作原因、成果链接与验收项');
    const actor = request.principal ?? '';
    const source = request.authKind === 'bearer' ? 'cli' : 'web';
    try {
      const action = command.data.action;
      const data = action === 'recover_execution' || action === 'release_assignment' || action === 'cancel_execution'
        ? await execution.apply(code.data, actor, command.data, source)
        : await delivery.apply(code.data, actor, command.data, source);
      return { ok: true as const, data };
    } catch (error) { return fail(error); }
  });
}
