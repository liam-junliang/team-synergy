import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../packages/persistence/dist/index.js';
import { createTestFixture } from './test-database-guard.mjs';

/** Dedicated fresh DB only. Never truncate or migrate the database supplied by caller. */
export async function withIntegrityFixture(baseUrl, label, run) {
  const fixture = await createTestFixture(label, baseUrl);
  let db;
  try {
    db=await openDb({databaseUrl:fixture.databaseUrl,migrationsFolder:fileURLToPath(new URL('../packages/persistence/drizzle',import.meta.url))});
    await seedIntegrityFixture(db);
    return await run(db,fixture.databaseUrl);
  } finally {
    if(db)await closeDb(db);
    await fixture.dispose();
  }
}

export async function seedIntegrityFixture(db) {
  const q=(text,values=[])=>db.$client.query(text,values).then(result=>result.rows[0]);
  const time='2026-10-23T00:00:00.000Z';
  const user=await q('INSERT INTO users(account,display_name,created_at) VALUES ($1,$1,$2) RETURNING id',['integrity.fixture',time]);
  const team=await q('INSERT INTO teams(name,created_by,owner_principal_id,created_at) VALUES ($1,$2,$2,$3) RETURNING id',['Fixture team',user.id,time]);
  const projects=[];
  for(const name of ['Fixture A','Fixture B']) projects.push(await q('INSERT INTO projects(team_id,name,created_by,owner_principal_id,created_at) VALUES ($1,$2,$3,$3,$4) RETURNING id',[team.id,name,user.id,time]));
  const module=await q('INSERT INTO project_modules(project_id,name,created_at,updated_at) VALUES ($1,$2,$3,$3) RETURNING id',[projects[0].id,'Fixture module',time]);
  const feature=await q('INSERT INTO features(project_id,module_id,title,status) VALUES ($1,$2,$3,$4) RETURNING id',[projects[0].id,module.id,'Fixture feature','active']);
  const task=await q('INSERT INTO tasks(feature_id,title,profile,acceptance,base_snapshot,created_at) VALUES ($1,$2,$3,$4,0,$5) RETURNING id',[feature.id,'Fixture task','builder','[]',time]);
  await q('INSERT INTO members(project_id,principal_id,role,display_name,created_at) VALUES ($1,$2,$3,$4,$5)',[projects[0].id,user.id,'owner','Fixture',time]);
  const device=await q('INSERT INTO devices(principal_id,credential_hash,device_name,created_at) VALUES ($1,$2,$3,$4) RETURNING id',[user.id,'0'.repeat(64),'Fixture device',time]);
  await q('INSERT INTO device_sessions(device_id,token_hash,created_at) VALUES ($1,$2,$3)',[device.id,'1'.repeat(64),time]);
  const connection=await db.$client.connect();
  try {
    await connection.query('BEGIN');
    const workspace=(await connection.query('INSERT INTO workspaces(run_id,path,git_base,created_at) VALUES (-1,$1,$2,$3) RETURNING id',['/fixture','fixture',time])).rows[0];
    const run=(await connection.query('INSERT INTO runs(task_id,principal_id,profile,workspace_id,base_snapshot,started_at) VALUES ($1,$2,$3,$4,0,$5) RETURNING id',[task.id,user.id,'builder',workspace.id,time])).rows[0];
    await connection.query('UPDATE workspaces SET run_id=$1 WHERE id=$2',[run.id,workspace.id]);
    await connection.query('COMMIT');
  } catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}
  await q('INSERT INTO audit_events(timestamp,principal_id,action,entity_type,entity_id,base_snapshot) VALUES ($1,$2,$3,$4,$5,0)',[time,user.id,'task.created','task',task.id]);
  const intake=await q("INSERT INTO intake_batches(project_id,namespace,created_by,source_json,payload_hash,submit_key,submit_hash,status,created_at,updated_at) VALUES ($1,'fixture',$2,'{}','fixture','fixture','fixture','draft',$3,$3) RETURNING id",[projects[0].id,user.id,time]);
  await q('INSERT INTO audit_events(timestamp,principal_id,action,entity_type,entity_id,base_snapshot) VALUES ($1,$2,$3,$4,$5,0)',[time,user.id,'intake.submitted','intake_batch',intake.id]);
  return {user,team,projects,module,feature,task};
}
