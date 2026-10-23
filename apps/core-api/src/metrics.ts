import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { TaskStatusSchema } from '@team-synergy/contracts';
import { readOperationalMetrics } from '@team-synergy/application';
import { observeSlowQueries, withDatabaseRequestContext, type Db } from '@team-synergy/persistence';
import { unauthorized } from './auth.js';

const agentStatuses = ['queued', 'running', 'awaiting_review', 'applied', 'rejected', 'failed', 'cancelled'] as const;
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const routeOf = (request: FastifyRequest) => request.routeOptions?.url ?? 'unmatched';
const methodOf = (request: FastifyRequest) => methods.has(request.method) ? request.method : 'OTHER';

/** Register before auth so rejected requests are counted too. One registry belongs to one server. */
export function registerMetrics(app: FastifyInstance, db: Db) {
  const registry = new Registry();
  const requests = new Counter({ name: 'tsp_http_requests_total', help: 'Completed HTTP requests.',
    labelNames: ['method', 'route', 'status_code'], registers: [registry] });
  const latency = new Histogram({ name: 'tsp_http_request_duration_seconds', help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
  new Gauge({ name: 'tsp_db_pool_connections', help: 'Database pool connections and queued acquisitions.',
    labelNames: ['state'], registers: [registry], collect() {
      this.set({ state: 'total' }, db.$client.totalCount ?? 0);
      this.set({ state: 'idle' }, db.$client.idleCount ?? 0);
      this.set({ state: 'active' }, Math.max(0, (db.$client.totalCount ?? 0) - (db.$client.idleCount ?? 0)));
      this.set({ state: 'waiting' }, db.$client.waitingCount ?? 0);
    } });
  const tasks = new Gauge({ name: 'tsp_tasks', help: 'Current persisted tasks by bounded status.', labelNames: ['status'], registers: [registry] });
  const jobs = new Gauge({ name: 'tsp_system_agent_jobs', help: 'Current persisted System Agent jobs by bounded status.', labelNames: ['status'], registers: [registry] });
  const success = new Gauge({ name: 'tsp_system_agent_generation_success_ratio',
    help: 'Successful generations (awaiting review, applied or rejected) divided by successful plus failed generations. Zero when no completed generations exist.', registers: [registry] });
  const starts = new WeakMap<FastifyRequest, number>();
  const removeObserver = observeSlowQueries(db, event => app.log.warn({ ...event }, 'Slow database query'));
  app.addHook('onClose', async () => { removeObserver(); registry.clear(); });
  app.addHook('onRequest', (request, _reply, done) => {
    starts.set(request, performance.now());
    withDatabaseRequestContext({ route: routeOf(request), method: methodOf(request), request_id: request.id }, done);
  });
  app.addHook('onResponse', async (request, reply) => {
    const labels = { method: methodOf(request), route: routeOf(request), status_code: String(reply.statusCode) };
    requests.inc(labels);
    latency.observe(labels, (performance.now() - (starts.get(request) ?? performance.now())) / 1000);
    starts.delete(request);
  });
  app.get('/metrics', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    const current = await readOperationalMetrics(db, request.principal).catch(() => null);
    if (!current) return reply.code(503).send({ ok: false, error: { code: 'metrics_unavailable', message: '运行指标暂不可用' } });
    if (!current.ok) return reply.code(403).send(current);
    const taskCounts = new Map(current.data.tasks.map(row => [row.status, row.count]));
    for (const status of TaskStatusSchema.options) tasks.set({ status }, taskCounts.get(status) ?? 0);
    const jobCounts = new Map(current.data.jobs.map(row => [row.status, row.count]));
    for (const status of agentStatuses) jobs.set({ status }, jobCounts.get(status) ?? 0);
    const generated = ['awaiting_review', 'applied', 'rejected'].reduce((total, status) => total + (jobCounts.get(status as typeof agentStatuses[number]) ?? 0), 0);
    const completed = generated + (jobCounts.get('failed') ?? 0);
    success.set(completed ? generated / completed : 0);
    return reply.type(registry.contentType).send(await registry.metrics());
  });
  return registry;
}
