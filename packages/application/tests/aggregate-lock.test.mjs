import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { lockAggregate, lockScope } from '../dist/aggregate-lock.js';
import { tryLockProjectSystemFolders } from '../dist/project-document-folders.js';
import { insertProject, insertTeam, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

test('100 concurrent writes to different projects bypass a held project fence with no advisory wait chain', async () => {
  const db = fixture.db;
  const team = await insertTeam(db, { name: 'Scoped locks' });
  const projects = await Promise.all(Array.from({ length: 101 }, (_, i) => insertProject(db, { teamId: team.id, name: `Project ${i}` })));
  let release;
  let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const holder = db.transaction(async tx => {
    await lockAggregate(tx, 'project', projects[0].id);
    acquired();
    await barrier;
  });
  await ready;
  try {
    const writes = projects.slice(1).map((project, i) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      await tx.update(schema.projects).set({ name: `Updated ${i}` }).where(eq(schema.projects.id, project.id));
      const waits = await tx.execute(sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`);
      assert.equal(waits.rows[0].count, 0, 'independent projects must have no advisory wait chain');
    }));
    await Promise.all(writes);
    assert.equal((await db.select().from(schema.projects)).filter(row => row.name.startsWith('Updated')).length, 100);
    const probe = await db.transaction(async tx => ({
      same: await tryLockProjectSystemFolders(tx, projects[0].id),
      other: await tryLockProjectSystemFolders(tx, projects[1].id),
    }));
    assert.deepEqual(probe, { same: false, other: true });
    const locks = await db.execute(sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and objid = 1094930512::oid and database = (select oid from pg_database where datname = current_database())`);
    assert.equal(locks.rows[0].count, 0, 'legacy global material lock must be absent');
  } finally {
    release();
    await holder;
  }
});

test('shared project readers block exclusive writers while separate aggregate scopes remain independent', async () => {
  await fixture.db.transaction(async reader => {
    await lockAggregate(reader, 'project', 'same', true);
    await fixture.db.transaction(async writer => {
      const result = await writer.execute(sql`select pg_try_advisory_xact_lock(${lockScope('project', 'same')}) as same, pg_try_advisory_xact_lock(${lockScope('document', 'same')}) as other`);
      assert.deepEqual(result.rows[0], { same: false, other: true });
    });
  });
});
