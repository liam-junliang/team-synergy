import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { buildServer } from '../dist/server.js';
import { processNextMemoryCapture } from '../dist/memory-capture-queue.js';

const database = process.env.TSP_TEST_DATABASE_URL;
async function fixture(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(r => r.rows);
  const [project] = await q("select id,code from projects where name='Fixture A'");
  const [owner] = await q("select id,code from users where account='integrity.fixture'");
  const [other] = await q("insert into users(account,display_name,created_at) values('memory.other','Other','t0') returning id,code");
  const headers = [];
  for (const user of [owner, other]) {
    const token = 'governance-test-' + user.code;
    await q('insert into devices(principal_id,device_name,credential_hash,created_at) values($1,$2,$3,$2)',
      [user.id, 'governance', createHash('sha256').update(token).digest('hex')]);
    headers.push({ authorization: 'Bearer ' + token });
  }
  await q("insert into members(project_id,principal_id,role,display_name,created_at) values($1,$2,'member','Other','t0')", [project.id, other.id]);
  return { q, project, owner, other, headers, route: '/projects/' + project.code + '/memory' };
}

test('unbound capture is durable, private management is versioned and old citations are invalidated', { skip: !database },
  async () => withIntegrityFixture(database, 'personalapi', async db => {
    const oldEnabled = process.env.TSP_MEMORY_ENABLED;
    process.env.TSP_MEMORY_ENABLED = '1';
    const f = await fixture(db);
    const app = await buildServer({ db, logger: false });
    try {
      const body = { sessionId: 'no-task', eventId: 'turn-1', sourceText: '我习惯在本项目使用中文提交说明。' };
      const enqueue = await app.inject({ method: 'POST', url: f.route + '/capture-events', headers: f.headers[0], payload: body });
      assert.equal(enqueue.statusCode, 202);
      const job = enqueue.json().data;
      assert.equal(job.status, 'pending');
      const duplicate = await app.inject({ method: 'POST', url: f.route + '/capture-events', headers: f.headers[0], payload: body });
      assert.equal(duplicate.json().data.captureCode, job.captureCode);
      const foreign = await app.inject({ method: 'GET', url: f.route + '/captures/' + job.captureCode, headers: f.headers[1] });
      assert.equal(foreign.statusCode, 404);
      const conflict = await app.inject({ method: 'POST', url: f.route + '/capture-events', headers: f.headers[0], payload: { ...body, sourceText: 'changed' } });
      assert.equal(conflict.statusCode, 409);
      await processNextMemoryCapture(db, async text => [{ kind: 'preference', text }]);
      const status = await app.inject({ method: 'GET', url: f.route + '/captures/' + job.captureCode, headers: f.headers[0] });
      assert.equal(status.json().data.status, 'completed');
      assert.ok(!JSON.stringify(status.json()).includes('payload_json'));
      const listing = await app.inject({ method: 'GET', url: '/memory/personal', headers: f.headers[0] });
      assert.equal(listing.statusCode, 200);
      const original = listing.json().data.items[0];
      assert.equal(original.applicability, 'project');
      const path = '/memory/personal/' + original.source;
      const denied = await app.inject({ method: 'GET', url: path, headers: f.headers[1] });
      assert.equal(denied.statusCode, 404);
      const edited = await app.inject({ method: 'PATCH', url: path, headers: f.headers[0], payload: {
        expectedRevision: original.revision, text: '我在本项目偏好英文提交说明。', reason: '显式纠正',
      } });
      assert.equal(edited.statusCode, 200);
      const latest = edited.json().data;
      assert.equal(latest.source, original.source);
      assert.notEqual(latest.revisionSource, original.revisionSource);
      assert.equal(latest.revision, original.revision + 1);
      const stale = await app.inject({ method: 'PATCH', url: path, headers: f.headers[0], payload: { expectedRevision: original.revision, text: 'overwrite' } });
      assert.equal(stale.statusCode, 409);
      const oldSource = await app.inject({ method: 'POST', url: f.route + '/sources', headers: f.headers[0], payload: { sources: [original.revisionSource] } });
      assert.deepEqual(oldSource.json().data, []);
      const withdrawn = await app.inject({ method: 'POST', url: path + '/withdraw', headers: f.headers[0], payload: { expectedRevision: latest.revision } });
      assert.equal(withdrawn.statusCode, 200);
      assert.equal(withdrawn.json().data.status, 'withdrawn');
      const active = await app.inject({ method: 'GET', url: '/memory/personal', headers: f.headers[0] });
      assert.deepEqual(active.json().data.items, []);
      const history = await app.inject({ method: 'GET', url: path, headers: f.headers[0] });
      assert.equal(history.json().data.history.length, 3);
      const completedJob = await app.inject({ method: 'GET', url: f.route + '/captures/' + job.captureCode, headers: f.headers[0] });
      assert.equal(completedJob.json().data.status,'completed');
      assert.deepEqual(completedJob.json().data.result.items,[]);
      assert.ok(!completedJob.body.includes(original.text));
      const replayWithdrawn = await app.inject({method:'POST',url:f.route+'/capture-events',headers:f.headers[0],payload:body});
      assert.deepEqual(replayWithdrawn.json().data.result.items,[]);
      assert.ok(!replayWithdrawn.body.includes(original.text));
      assert.equal((await f.q('select count(*)::int n from requirement_topic_entries'))[0].n, 0);
      assert.equal((await f.q('select count(*)::int n from memory_projection_jobs where engine=\'tencent\''))[0].n, 0);
    } finally {
      await app.close();
      if (oldEnabled === undefined) delete process.env.TSP_MEMORY_ENABLED; else process.env.TSP_MEMORY_ENABLED = oldEnabled;
    }
  }));

test('capture worker retries model failure without changing the source and asks before unbound adoption', { skip: !database },
  async () => withIntegrityFixture(database, 'capturequeue', async db => {
    const oldEnabled = process.env.TSP_MEMORY_ENABLED;
    process.env.TSP_MEMORY_ENABLED = '1';
    const f = await fixture(db), app = await buildServer({ db, logger: false });
    try {
      const result = await app.inject({ method: 'POST', url: f.route + '/capture-events', headers: f.headers[0], payload: {
        sessionId: 'queue', eventId: 'first', sourceText: '就按这个方案做。',
      } });
      const code = result.json().data.captureCode;
      await processNextMemoryCapture(db, async () => { throw Error('private upstream details'); });
      const failed = await app.inject({ method: 'GET', url: f.route + '/captures/' + code, headers: f.headers[0] });
      assert.equal(failed.json().data.status, 'failed');
      assert.ok(!failed.body.includes('private upstream details'));
      const retried = await app.inject({ method: 'POST', url: f.route + '/captures/' + code + '/retry', headers: f.headers[0] });
      assert.equal(retried.json().data.status, 'pending');
      await processNextMemoryCapture(db, async text => [{ kind: 'adopt', text }]);
      const clarified = await app.inject({ method: 'GET', url: f.route + '/captures/' + code, headers: f.headers[0] });
      assert.equal(clarified.json().data.status, 'needs_clarification');
      const rejectRetry = await app.inject({ method: 'POST', url: f.route + '/captures/' + code + '/retry', headers: f.headers[0] });
      assert.equal(rejectRetry.statusCode, 409);
      assert.equal((await f.q('select count(*)::int n from memory_capture_receipts'))[0].n, 0);
    } finally {
      await app.close();
      if (oldEnabled === undefined) delete process.env.TSP_MEMORY_ENABLED; else process.env.TSP_MEMORY_ENABLED = oldEnabled;
    }
  }));

test('an exhausted crashed lease becomes terminal and releases later events in the same session', { skip: !database },
  async () => withIntegrityFixture(database, 'capturelease', async db => {
    const enabled = process.env.TSP_MEMORY_ENABLED;
    process.env.TSP_MEMORY_ENABLED = '1';
    const f = await fixture(db), app = await buildServer({ db, logger: false });
    try {
      const codes = [];
      for (const eventId of ['expired','next']) {
        const response = await app.inject({ method:'POST',url:f.route+'/capture-events',headers:f.headers[0],
          payload:{sessionId:'ordered',eventId,sourceText:'我习惯先核对来源。'} });
        assert.equal(response.statusCode,202);
        codes.push(response.json().data.captureCode);
      }
      await f.q("update memory_capture_jobs set status='processing',attempts=5,lease_until=now()-interval '1 second' where code=$1",[codes[0]]);
      await processNextMemoryCapture(db,async text=>[{kind:'preference',text}]);
      const statuses = await f.q('select code,status from memory_capture_jobs order by id');
      assert.deepEqual(statuses.map(row=>row.status),['failed','completed']);
      const retry = await app.inject({method:'POST',url:f.route+'/captures/'+codes[0]+'/retry',headers:f.headers[0]});
      assert.equal(retry.statusCode,409);
    } finally {
      await app.close();
      if (enabled === undefined) delete process.env.TSP_MEMORY_ENABLED; else process.env.TSP_MEMORY_ENABLED=enabled;
    }
  }));

test('an expired extraction cannot apply a late native effect after the next event completes', { skip: !database },
  async () => withIntegrityFixture(database, 'capturefence', async db => {
    const enabled=process.env.TSP_MEMORY_ENABLED;process.env.TSP_MEMORY_ENABLED='1';
    const f=await fixture(db), app=await buildServer({db,logger:false});
    let release, started;
    const gate=new Promise(resolve=>{release=resolve;}), entered=new Promise(resolve=>{started=resolve;});
    let pending;
    try {
      const codes=[];
      for(const [eventId,sourceText] of [['first','我习惯先写旧版草稿。'],['next','我习惯先核对最新来源。']]){
        const response=await app.inject({method:'POST',url:f.route+'/capture-events',headers:f.headers[0],payload:{sessionId:'effect-fence',eventId,sourceText}});
        codes.push(response.json().data.captureCode);
      }
      pending=processNextMemoryCapture(db,async text=>{started();await gate;return[{kind:'preference',text}];});
      await entered;
      await f.q("update memory_capture_jobs set attempts=5,lease_until=now()-interval '1 second' where code=$1",[codes[0]]);
      await processNextMemoryCapture(db,async text=>[{kind:'preference',text}]);
      release();assert.equal((await pending).status,'lease_changed');
      const receipts=await f.q('select event_key from memory_capture_receipts');
      assert.deepEqual(receipts.map(row=>row.event_key),['next']);
      assert.equal((await f.q('select count(*)::int n from memory_fragments'))[0].n,1);
    } finally {
      release();await pending?.catch(()=>{});await app.close();
      if(enabled===undefined)delete process.env.TSP_MEMORY_ENABLED;else process.env.TSP_MEMORY_ENABLED=enabled;
    }
  }));

test('a completed bound event replays its original witness without requiring the head it already advanced', { skip: !database },
  async () => withIntegrityFixture(database, 'capturebound', async db => {
    const enabled=process.env.TSP_MEMORY_ENABLED;process.env.TSP_MEMORY_ENABLED='1';
    const f=await fixture(db), app=await buildServer({db,logger:false});
    try {
      const [feature]=await f.q('select id from features where project_id=$1',[f.project.id]);
      const [topic]=await f.q("insert into requirement_topics(project_id,title,created_by,created_at,updated_at) values($1,'Bound',$2,'t0','t0') returning code",[f.project.id,f.owner.id]);
      const [requirement]=await f.q("insert into requirements(feature_id,title,current_revision,state,owner_principal_id) values($1,'Bound',1,'draft',$2) returning code",[feature.id,f.owner.id]);
      const input={sessionId:'bound',eventId:'stable',sourceText:'我建议先记录讨论。',topicCode:topic.code,requirementCode:requirement.code,expectedHead:null,expectedRevision:1};
      const first=await app.inject({method:'POST',url:f.route+'/capture-events',headers:f.headers[0],payload:input});
      assert.equal(first.statusCode,202);
      await processNextMemoryCapture(db,async text=>[{kind:'discussion',text}]);
      const again=await app.inject({method:'POST',url:f.route+'/capture-events',headers:f.headers[0],payload:input});
      assert.equal(again.statusCode,202);
      assert.equal(again.json().data.captureCode,first.json().data.captureCode);
      assert.equal(again.json().data.result.items.length,1);
      assert.equal((await f.q('select count(*)::int n from requirement_topic_entries'))[0].n,1);
    } finally {
      await app.close();
      if(enabled===undefined)delete process.env.TSP_MEMORY_ENABLED;else process.env.TSP_MEMORY_ENABLED=enabled;
    }
  }));
