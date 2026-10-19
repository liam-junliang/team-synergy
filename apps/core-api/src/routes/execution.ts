import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createExecutionUseCases, fail, resolveSessionToken } from '@team-synergy/application';
import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';

/** Identity comes exclusively from an authenticated device bearer, never the body. */
export function registerExecutionRoutes(app: FastifyInstance, db: Db): void {
  const execution = createExecutionUseCases(db);
  async function identity(request: FastifyRequest) {
    if (request.authKind !== 'bearer' || !request.authDeviceToken) throw new DomainError('unauthorized', '请先登录当前设备');
    const device = (await resolveSessionToken(db, request.authDeviceToken))?.device;
    if (!device) throw new DomainError('unauthorized', '设备凭据无效');
    return { principalId: device.principal_id, deviceId: device.id };
  }
  async function result<T>(action: () => Promise<T>) { try { return { ok: true as const, data: await action() }; } catch (error) { return fail(error); } }
  type RunParams = { run_code: string };
  app.get<{ Params: RunParams }>('/runs/:run_code/execution', request => result(async () => execution.context(request.params.run_code, await identity(request))));
  app.get<{ Params: RunParams }>('/runs/:run_code/sessions', request => result(async () => execution.sessions(request.params.run_code, await identity(request))));
  app.post<{ Params: RunParams; Body: { execution_epoch?: number } }>('/runs/:run_code/lease', request => result(async () => execution.lease(request.params.run_code, await identity(request), request.body?.execution_epoch)));
  app.post<{ Params: RunParams; Body: { execution_epoch: number; lease_token: string } }>('/runs/:run_code/lease/renew', request => result(async () => {
    const body = request.body;
    if (!body || typeof body.lease_token !== 'string' || !Number.isSafeInteger(body.execution_epoch)) throw new DomainError('validation_failed', '需要租约和执行代数');
    return execution.renew(request.params.run_code, await identity(request), body.lease_token, body.execution_epoch);
  }));
  app.post<{ Params: RunParams; Body: Parameters<ReturnType<typeof createExecutionUseCases>['start']>[2] }>('/runs/:run_code/sessions', request => result(async () => {
    const body = request.body;
    if (!body || typeof body.start_key !== 'string' || typeof body.agent_command !== 'string' || typeof body.lease_token !== 'string' || !Number.isSafeInteger(body.execution_epoch) || body.launch_kind !== undefined && !['default','custom'].includes(body.launch_kind) || body.prompt_path !== undefined && typeof body.prompt_path !== 'string') throw new DomainError('validation_failed', '启动参数无效');
    return execution.start(request.params.run_code, await identity(request), body);
  }));
  app.post<{ Params: { session_code: string }; Body: Parameters<ReturnType<typeof createExecutionUseCases>['state']>[2] }>('/agent-sessions/:session_code/state', request => result(async () => {
    const body = request.body;
    if (!body || !['running','finished','failed','cancelled'].includes(body.status) || typeof body.lease_token !== 'string' || !Number.isSafeInteger(body.execution_epoch) || body.last_output != null && typeof body.last_output !== 'string' || body.last_error != null && typeof body.last_error !== 'string' || body.process_id !== undefined && !Number.isSafeInteger(body.process_id) || body.exit_code != null && !Number.isSafeInteger(body.exit_code)) throw new DomainError('validation_failed', '会话状态参数无效');
    return execution.state(request.params.session_code, await identity(request), body);
  }));
}
