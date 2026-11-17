import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import type { Db } from './db.js';

/** One client, one read-only snapshot and one deadline including pool acquisition. */
export async function withReadOnlySnapshot<T>(db: Pick<Db, '$client'>, work: (client: PoolClient) => Promise<T>, label = 'Integrity'): Promise<T> {
  const started = performance.now();
  let expired = false;
  const connecting = db.$client.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = await Promise.race([connecting.then(client => { if (expired) client.release(); return client; }), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error(`${label} connection deadline exceeded`)); }, 9000);
  })]).finally(() => { clearTimeout(timer); });
  let released = false;
  const release = (destroy = false) => { if (!released) { released = true; client.release(destroy); } };
  let deadlineExpired = false;
  const execute = async () => {
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const remaining = Math.max(1, 9000 - Math.ceil(performance.now() - started));
      await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      await client.query('SET LOCAL search_path = pg_catalog,public,pg_temp');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { if (!deadlineExpired) await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { release(); }
  };
  try {
    return await Promise.race([execute(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { deadlineExpired = true; release(true); reject(new Error(`${label} query deadline exceeded`)); }, Math.max(1, 9000 - Math.ceil(performance.now() - started)));
    })]);
  } finally { clearTimeout(timer); }
}
