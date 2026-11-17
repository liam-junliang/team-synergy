import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@team-synergy/persistence';
import { createProjectPolicyUseCases, createProjectUseCasesProject } from '../dist/index.js';
import { seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
test('policy change and ordinary project edit take the project fence before user rows', async () => {
 const db = fixture.db;
 const { project, users } = await seedWorkspaceProject(db,{ teamName:'Policy fences',projectName:'Policy project',users:[
  { key:'owner',account:'owner',displayName:'Owner',teamRole:'owner',projectRole:'owner' },
 ] });
 await db.update(schema.projects).set({ owner_principal_id:users.owner.id }).where(eq(schema.projects.id,project.id));
 const originalTransaction = db.transaction.bind(db), dialect = new PgDialect();
 let signal, release, first = true, rename, policy;
 const acquired = new Promise(resolve => { signal = resolve; });
 const barrier = new Promise(resolve => { release = resolve; });
 db.transaction = (work,...args) => originalTransaction(async tx => {
  if (first) {
   first = false;
   const execute = tx.execute.bind(tx);
   let fenced = false;
   tx.execute = async statement => {
    const result = await execute(statement);
    if (!fenced && dialect.sqlToQuery(statement).sql.includes('pg_advisory_xact_lock')) {
     fenced = true;
     const pid = await execute(sql`select pg_backend_pid() as pid`);
     signal(pid.rows[0].pid);
     await barrier;
    }
    return result;
   };
  }
  return work(tx);
 },...args);
 try {
  rename = createProjectUseCasesProject(db).updateProject({ projectCode:project.code,principalCode:users.owner.code,name:'Edited concurrently' });
  const pid = await acquired;
  policy = createProjectPolicyUseCases(db).updatePolicy({ projectCode:project.code,principalCode:users.owner.code,memberPolicy:'team_write' });
  let waiting = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
   const locks = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted and ${pid}::integer = any(pg_blocking_pids(pid))`);
   if (locks.rows.length) { waiting = true; break; }
   await new Promise(resolve => setTimeout(resolve,10));
  }
  assert.equal(waiting,true,'policy mutation must wait on the actual project edit fence');
  release();
  for (const result of await Promise.all([rename,policy])) assert.equal(result.ok,true,JSON.stringify(result));
  const [updated] = await db.select().from(schema.projects).where(eq(schema.projects.id,project.id));
  assert.equal(updated.name,'Edited concurrently');
  assert.equal(updated.member_policy,'team_write');
 } finally {
  release();
  await Promise.allSettled([rename,policy].filter(Boolean));
  db.transaction = originalTransaction;
 }
});
