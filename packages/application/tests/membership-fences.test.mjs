import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createMemberUseCases, createTeamUseCases, createProjectUseCasesProject } from '../dist/index.js';
import { lockAggregate, lockScope } from '../dist/aggregate-lock.js';
import { addProjectMember, insertProject, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function seed() {
 const db = fixture.db;
 const seeded = await seedWorkspaceProject(db, { teamName: 'Governance fences', projectName: 'First', users: [
  { key: 'owner', account: 'owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
  { key: 'member', account: 'member', displayName: 'Member', teamRole: 'member', projectRole: 'admin' },
 ] });
 return { db, ...seeded };
}
async function waitForFenceWaiter(db, projectId) {
 const deadline = Date.now() + 3000;
 while (Date.now() < deadline) {
  const result = await db.execute(sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted and objid = ((${lockScope('project', projectId)}) & 4294967295)::oid and database = (select oid from pg_database where datname = current_database())`);
  if (result.rows[0].count > 0) return;
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 assert.fail('membership writer must wait on the project fence');
}
async function assertUserUnlocked(db, userId) {
 await db.transaction(async tx => {
  await tx.execute(sql`set local lock_timeout = '100ms'`);
  await tx.select().from(schema.users).where(eq(schema.users.id,userId)).for('update');
 });
}

test('project membership demotion waits on the context fence before acquiring user rows', async () => {
 const { db, project, users } = await seed();
 const ready = deferred(), release = deferred();
 const holder = db.transaction(async tx => { await lockAggregate(tx,'project',project.id,true); ready.resolve(); await release.promise; });
 await ready.promise;
 const mutation = createMemberUseCases(db).updateMemberRole({ projectCode: project.code, actorPrincipalCode: users.owner.code, userCode: users.member.code, role: 'viewer' });
 try {
  await waitForFenceWaiter(db,project.id);
  await assertUserUnlocked(db,users.member.id);
  const [member] = await db.select().from(schema.members).where(and(eq(schema.members.project_id,project.id),eq(schema.members.principal_id,users.member.id)));
  assert.equal(member.role,'admin');
 } finally { release.resolve(); await holder; }
 const result = await mutation;
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.data.role,'viewer');
});

test('team revocation fences projects in ascending order before user rows and removes every project grant', async () => {
 const { db, project, team, users } = await seed();
 const second = await insertProject(db,{ teamId: team.id, name: 'Second' });
 await addProjectMember(db,{ projectId:second.id, principalId:users.member.id, role:'member', displayName:'Member' });
 const ready = deferred(), release = deferred();
 const holder = db.transaction(async tx => { await lockAggregate(tx,'project',second.id,true); ready.resolve(); await release.promise; });
 await ready.promise;
 const mutation = createTeamUseCases(db).removeMember({ teamCode:team.code,actorPrincipalCode:users.owner.code,userCode:users.member.code });
 try {
  await waitForFenceWaiter(db,second.id);
  await assertUserUnlocked(db,users.member.id);
  await db.transaction(async tx => {
   const result = await tx.execute(sql`select pg_try_advisory_xact_lock(${lockScope('project',project.id)}) as acquired`);
   assert.equal(result.rows[0].acquired,false,'the first project fence must precede the second');
  });
 } finally { release.resolve(); await holder; }
 const result = await mutation;
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(new Set(result.data.revoked_project_codes),new Set([project.code,second.code]));
 assert.equal((await db.select().from(schema.members).where(eq(schema.members.principal_id,users.member.id))).length,0);
 assert.equal((await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.principal_id,users.member.id))).length,0);
});

test('team membership retries project enumeration when a normal createProject commits before governance rows', async () => {
 const { db, team, users } = await seed();
 const ready = deferred(), release = deferred();
 let firstFence = true, transactions = 0;
 const wrapped = new Proxy(db,{ get(target,property) {
  if (property === 'transaction') return work => { transactions++; return target.transaction(tx => work(new Proxy(tx,{ get(transaction,key) {
   const value = Reflect.get(transaction,key);
   if (key === 'execute') return async (...args) => {
    const result = await value.apply(transaction,args);
    if (firstFence) { firstFence = false; ready.resolve(); await release.promise; }
    return result;
   };
   return typeof value === 'function' ? value.bind(transaction) : value;
  } }))); };
  const value = Reflect.get(target,property); return typeof value === 'function' ? value.bind(target) : value;
 } });
 const mutation = createTeamUseCases(wrapped).removeMember({ teamCode:team.code,actorPrincipalCode:users.owner.code,userCode:users.member.code });
 await ready.promise;
 try {
  const created = await createProjectUseCasesProject(db).createProject({ teamCode:team.code,name:'Concurrent project',principalCode:users.owner.code });
  assert.equal(created.ok,true,JSON.stringify(created));
 } finally { release.resolve(); }
 const result = await mutation;
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(transactions,2,'the changed project set requires a new transaction before more fences');
});
