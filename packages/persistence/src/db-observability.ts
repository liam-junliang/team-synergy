import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';

export interface DatabaseRequestContext {
  route: string;
  method: string;
  request_id: string;
}
export interface SlowQueryEvent extends Partial<DatabaseRequestContext> { duration_ms: number }
const context = new AsyncLocalStorage<DatabaseRequestContext>();
const slowQueryEvent = 'tsp:slow-query';

export function withDatabaseRequestContext<T>(value: DatabaseRequestContext, action: () => T): T {
  return context.run(value, action);
}

/** Subscribers receive timing/context only: query text, parameters and errors never enter telemetry. */
export function observeSlowQueries(db: { $client: Pool }, observer: (event: SlowQueryEvent) => void): () => void {
  // Some readiness tests borrow a query-only handle. Telemetry must not make it unusable.
  if (typeof db.$client.addListener !== 'function') return () => {};
  db.$client.addListener(slowQueryEvent, observer);
  return () => { db.$client.off(slowQueryEvent, observer); };
}

/** Instrument actual clients so checked-out transaction queries are measured as well as pool.query. */
export function instrumentDatabasePool(pool: Pool) {
  pool.on('connect', (client: PoolClient) => {
    const query = client.query;
    client.query = function (...args: unknown[]) {
      const started = performance.now();
      const request = context.getStore();
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        const duration_ms = performance.now() - started;
        if (duration_ms <= 500) return;
        const event: SlowQueryEvent = { duration_ms, ...request };
        // Telemetry must never change query success/failure behavior.
        for (const observer of pool.listeners(slowQueryEvent)) {
          try { Reflect.apply(observer, pool, [event]); } catch { /* A logging sink cannot fail database work. */ }
        }
      };
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
          finish();
          return Reflect.apply(callback, this, values);
        };
      }
      try {
        const result: unknown = Reflect.apply(query, client, args);
        if (result instanceof Promise) return result.then(
          value => { finish(); return value; },
          error => { finish(); throw error; },
        );
        return result;
      } catch (error) { finish(); throw error; }
    } as PoolClient['query'];
  });
}

