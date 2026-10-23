import { registerMetrics } from './metrics.js';
import { registerAuditRoutes } from './routes/audit.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import { ProfileSchema, TaskStatusSchema } from '@team-synergy/contracts';
import { canTransition } from '@team-synergy/domain';
import { createSystemAgentUseCases, ensureSystemAdmin } from '@team-synergy/application';
import { closeDb, openDb, databaseReady, resolveMigrationsFolder, type Db } from '@team-synergy/persistence';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerDefectRoutes } from './routes/defects.js';
import { registerUserRoutes } from './routes/users.js';
import { registerRequirementRoutes } from './routes/requirements.js';
import { registerRequirementDocumentRoutes } from './routes/requirement-documents.js';
import { registerRequirementCollaborationRoutes } from './routes/requirement-collaboration.js';
import { registerDesignPrototypeRoutes } from './routes/design-prototypes.js';
import { registerArchitectureDocumentRoutes } from './routes/architecture-documents.js';
import { registerProjectDocumentRoutes } from './routes/project-documents.js';
import { registerDocumentQualityRoutes } from './routes/document-quality.js';
import { registerAuthMiddleware } from './auth.js';
import { httpStatusForError } from './error-status.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerTeamRoutes } from './routes/teams.js';
import { registerHandoverRoutes } from './routes/handovers.js';
import { registerExecutionRoutes } from './routes/execution.js';
import { registerRequirementBaselineRoutes } from './routes/baselines.js';
import { registerOwnershipRoutes } from './routes/ownership.js';
import { registerTestingRoutes } from './routes/testing.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerCliDistributionRoutes } from './routes/cli-distribution.js';
import { registerSystemSettingsRoutes } from './routes/system-settings.js';
import { registerAdminGovernanceRoutes } from './routes/admin-governance.js';
import { registerIntakeRoutes } from './routes/intake.js';
import { registerSystemAgentRoutes } from './routes/system-agent.js';
import { createSystemAgentRuntime } from './system-agent-runtime.js';
import { loadSystemAgentGuidance } from './system-agent-guidance.js';
import { createSystemAgentWorker } from './system-agent-worker.js';

export interface BuildServerOptions {
  /** Borrow an existing handle. The caller remains responsible for closing it. */
  db?: Db;
  /** Override the default TSP_DATABASE_URL value when the server owns the database. */
  databaseUrl?: string;
  logger?: boolean;
  migrate?: boolean;
}

function bundledMigrationsFolder(): string {
  return resolveMigrationsFolder(path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'));
}

/** Build the modular Fastify server shared by production and inject-based tests. */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const ownsDb = options.db === undefined;
  const db =
    options.db ??
    await openDb({
      databaseUrl: options.databaseUrl,
      migrationsFolder: bundledMigrationsFolder(),
      migrate: options.migrate ?? process.env.TSP_AUTO_MIGRATE !== 'false',
    });
  // Large document payloads must opt in at the route boundary.
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ ok: false, error: { code: 'request_body_too_large', message: 'Request body exceeds the allowed size' } });
    }
    // Preserve Fastify's existing validation and unexpected-error semantics.
    return reply.send(error);
  });

  if (ownsDb) {
    const bootstrap = await ensureSystemAdmin(db).catch(async error => { await closeDb(db); throw error; });
    if (bootstrap.initial_password) {
      // 初始密码是敏感凭据，不能进入结构化日志（会被采集聚合）。
      // 只输出到 stderr 一次，由部署者当场抄走；日志里仅保留账号与过期时间。
      process.stderr.write(
        [
          '',
          '============================================================',
          'System admin initial credentials generated (one-time print).',
          `  account:       ${bootstrap.account}`,
          `  initial pwd:   ${bootstrap.initial_password}`,
          `  expires at:    ${bootstrap.expires_at}`,
          'Change the password immediately after first login.',
          '============================================================',
          '',
        ].join('\n') + '\n',
      );
      app.log.warn({
        account: bootstrap.account,
        expires_at: bootstrap.expires_at,
      }, 'System admin initial credentials generated; password printed once to stderr, change it after login');
    }
  }

  if (ownsDb) {
    app.addHook('onClose', async () => {
      await closeDb(db);
    });
  }

  app.register(swagger, {
    openapi: {
      info: {
        title: 'Team Synergy Core API',
        version: '0.1.0',
      },
    },
  });

  registerMetrics(app, db);
  registerAuthMiddleware(app, db);
  registerAuthRoutes(app, db);
  registerAuditRoutes(app, db);
  registerOwnershipRoutes(app, db);
  registerTestingRoutes(app, db);
  registerSkillRoutes(app, db);
  registerCliDistributionRoutes(app);
  registerSystemSettingsRoutes(app, db);
  registerAdminGovernanceRoutes(app, db);
  registerIntakeRoutes(app, db);

  const systemAgentRuntime = createSystemAgentRuntime();
  if (ownsDb) app.addHook('onReady', async () => { await systemAgentRuntime.cleanup(); });
  let systemAgentGuidance: ReturnType<typeof loadSystemAgentGuidance> | null = null;
  try { systemAgentGuidance = loadSystemAgentGuidance(); } catch { /* Explicitly unavailable until the packaged Skill is restored. */ }
  const systemAgentStatus = () => {
    const status = systemAgentRuntime.status();
    return systemAgentGuidance ? status : { ...status, configured: false, message: '系统 Agent 的 Skill 包缺失或校验失败，请重新构建服务' };
  };
  app.get('/system-agent/status', async () => ({ ok: true, data: systemAgentStatus() }));
  registerSystemAgentRoutes(app, db, { isConfigured: () => systemAgentStatus().configured });
  // Inject-based tests borrow a DB and never start a paid inference/background worker.
  if (ownsDb && systemAgentStatus().configured && systemAgentGuidance) {
    const status = systemAgentRuntime.status();
    const worker = createSystemAgentWorker({
      store: createSystemAgentUseCases(db), runtime: systemAgentRuntime, guidance: systemAgentGuidance.guidance,
      executionMetadata: { engine: status.engine, engine_version: status.version, model: status.model,
        skill_version: systemAgentGuidance.version, skill_sha256: systemAgentGuidance.sha256 },
      onError: code => app.log.warn({ code }, 'System Agent worker event'),
    });
    app.addHook('onReady', async () => { worker.start(); });
    app.addHook('onClose', async () => { await worker.stop(); });
  }

  // 统一错误状态码映射：业务拒绝（ok:false）不再一律 HTTP 200。
  // envelope 结构不变，仅按 error.code 提升状态码（docs/30 工程化缺漏 #2）。
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (reply.statusCode !== 200) return payload;
    if (typeof payload !== 'object' || payload === null) return payload;
    const candidate = payload as { ok?: unknown; error?: unknown };
    if (candidate.ok === false && typeof candidate.error === 'object' && candidate.error !== null) {
      const code = (candidate.error as { code?: unknown }).code;
      if (typeof code === 'string') {
        reply.code(httpStatusForError(code));
      }
    }
    return payload;
  });

  app.get('/ready', async (_request, reply) => {
    try {
      if (await databaseReady(db, bundledMigrationsFolder())) return { status: 'ready' };
    } catch { /* Dependency failures are readiness failures, never credential-bearing responses. */ }
    return reply.code(503).send({ status: 'not_ready' });
  });

  app.get('/health', async () => ({
    status: 'ok',
    project: 'team-synergy',
    contracts: {
      task_statuses: TaskStatusSchema.options,
      profiles: ProfileSchema.options,
    },
    domain_check: {
      'draft_to_ready': canTransition('draft', 'ready'),
      'closed_is_terminal': !canTransition('closed', 'draft'),
    },
  }));

  // 任务闭环全部路由（读：列表/详情/审计流；写：create/assign/claim/submit/verify/close）
  registerTaskRoutes(app, db);
  // 需求录入与当前 Revision/关联任务事实投影
  registerRequirementRoutes(app, db);
  registerRequirementBaselineRoutes(app, db);
  // 多份模块化需求文档与不可变 Revision 历史
  registerRequirementDocumentRoutes(app, db);
  // 想法、需求议题、决策时间线及可选的文档版本评审
  registerRequirementCollaborationRoutes(app, db);
  // 需求与开发之间的 HTML 原型及不可变 Revision
  registerDesignPrototypeRoutes(app, db);
  registerArchitectureDocumentRoutes(app, db);
  // 项目交接文档库：多级文件夹、多份文档及不可变 Revision
  registerProjectDocumentRoutes(app, db);
  registerDocumentQualityRoutes(app, db);
  // Defect 闭环（docs/19）
  registerDefectRoutes(app, db);
  // 用户账号（docs/23）
  registerUserRoutes(app, db);
  // 团队 → 项目层级
  registerTeamRoutes(app, db);
  // 项目（TASK-226）
  app.register(async (scope) => (await import('./routes/projects.js')).registerProjectRoutes(scope, db));
  // 设备管理（TASK-222）
  registerDeviceRoutes(app, db);
  registerHandoverRoutes(app, db);
  registerExecutionRoutes(app, db);

  return app;
}

/** Compatibility alias for the original core-api entry point and callers. */
export const buildApp = buildServer;
