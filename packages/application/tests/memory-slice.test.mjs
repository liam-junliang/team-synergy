import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';
import { createMemorySliceUseCases, createRequirementCollaborationUseCases, createRequirementUseCases } from '../dist/index.js';
import { lockAggregate } from '../dist/aggregate-lock.js';

const baseUrl = process.env.TSP_TEST_DATABASE_URL;

test('search keeps direct matches and preserves engine rank for additional visible sources',
  { skip: !baseUrl }, async () => withIntegrityFixture(baseUrl, 'memoryorder', async db => {
    const {memory,target,query} = await bindingFixture(db);
    const sources=[];
    for (const [index,text] of ['最早的相关记录','后来的相关记录','精确查找'].entries()) {
      const receipt=await memory.capture({...target,...await memory.inspect(target),sessionId:'ordering',eventId:String(index),
        sourceText:text,parts:[{kind:'discussion',text}]});
      await query(`update memory_projection_jobs j set status='synced',external_ref=$1 from memory_fragments f
        join requirement_topic_entries e on e.id=f.entry_id where j.fragment_id=f.id and e.code=$2`,['rank-'+index,receipt.expectedHead]);
      sources.push(receipt.expectedHead);
    }
    const result=await memory.searchEvidence({...target,scope:'project',query:'精确查找',engineRefs:['rank-0','rank-1']});
    assert.deepEqual(result.map(row=>[row.data.source,row.literal]),[[sources[2],true],[sources[0],false],[sources[1],false]]);
  }));

async function bindingFixture(db) {
    const query = (sql, params) => db.$client.query(sql, params).then(result => result.rows[0]);
    const project = await query("select * from projects where name='Fixture A'");
    const user = await query("select * from users where account='integrity.fixture'");
    const feature = await query('select id from features where project_id=$1', [project.id]);
    const topic = await query("insert into requirement_topics(project_id,title,created_by,created_at,updated_at) values($1,'Memory',$2,now(),now()) returning code", [project.id, user.id]);
    const req = await query("insert into requirements(feature_id,title,current_revision,state,owner_principal_id) values($1,'Memory',1,'draft',$2) returning id,code", [feature.id, user.id]);
    await query("insert into requirement_revisions(requirement_id,revision,summary,acceptance_criteria,created_at) values($1,1,'Background','[]',now())", [req.id]);
    const memory = createMemorySliceUseCases(db);
    const target = { projectCode: project.code, principalCode: user.code, topicCode: topic.code, requirementCode: req.code };
    return { query, project, user, req, target, memory };
}

test('concurrent delivery writes one receipt, and rejected adoption rolls back the decision and every projection',
  { skip: !baseUrl }, async () => withIntegrityFixture(baseUrl, 'memoryslice', async db => {
    const { query, user, req, target, memory } = await bindingFixture(db);
    const event = { ...target, ...await memory.inspect(target), sessionId: 'session', eventId: 'source', sourceText: '我建议退款超时需审核',
      parts: [{ kind: 'discussion', text: '我建议退款超时需审核' }] };
    const deliveries = await Promise.all([memory.capture(event), memory.capture(event)]);
    assert.equal((await memory.brief({ ...target, scope: 'project' }))[0]?.state, 'discussed');
    assert.deepEqual(await memory.brief({ ...target, scope: 'personal' }), []);
    assert.equal(new Set(deliveries.map(r => r.receiptCode)).size, 1);
    assert.deepEqual(deliveries.map(r => r.replayed).sort(), [false, true]);
    await assert.rejects(memory.capture({ ...event, sourceText: '替换已收录的来源' }), { code: 'memory_event_conflict' });

    await query("update requirements set state='confirmed' where id=$1", [req.id]);
    const adopt = { ...event, ...await memory.inspect(target), eventId: 'adopt', referenceText: '退款超时需审核', sourceText: '所有项目都用中文。就按这个方案做。',
      parts: [{ kind: 'preference', text: '所有项目都用中文。' }, { kind: 'adopt', text: '就按这个方案做。' }] };
    await assert.rejects(memory.capture(adopt), { code: 'requirement_revision_locked' });
    assert.deepEqual(await query('select (select count(*)::int from memory_capture_receipts) as receipts, (select count(*)::int from requirement_topic_entries) as entries, (select count(*)::int from memory_projection_jobs) as jobs'),
      { receipts: 1, entries: 1, jobs: 1 });
    assert.equal(await memory.replay(adopt), null);
    assert.deepEqual(await memory.search({ ...target, query: '中文' }), []);

    // Simulate stale engine hits. A candidate is visible only while both its delivery and native evidence are valid.
    const lookup = { ...target, query: '超出期限如何处理', scope: 'project', engineRefs: ['project-hit'] };
    await query("update memory_projection_jobs set external_ref='project-hit'");
    assert.deepEqual(await memory.search(lookup), []);
    await query("update memory_projection_jobs set status='synced'");
    assert.equal((await memory.search(lookup))[0]?.source, deliveries[0].expectedHead);
    assert.equal((await memory.readSources({...target,sources:[deliveries[0].expectedHead]}))[0]?.source,deliveries[0].expectedHead);
    assert.deepEqual(await memory.search({ ...lookup, scope: 'personal' }), []);
    await query('update requirement_topic_entries set withdrawn_at=now(), withdrawn_by=$1 where code=$2', [user.id, deliveries[0].expectedHead]);
    assert.deepEqual(await memory.brief({ ...target, scope: 'project' }), []);
    assert.deepEqual(await memory.search(lookup), []);
    assert.deepEqual((await memory.replay(event)).items, []);
    assert.deepEqual(await memory.readSources({...target,sources:[deliveries[0].expectedHead]}),[]);
    await query('update users set pending_deletion=true where id=$1', [user.id]);
    await assert.rejects(memory.brief({ ...target, scope: 'project' }), { code: 'project_forbidden' });
    await assert.rejects(memory.replay(event), { code: 'project_forbidden' });
    await assert.rejects(memory.readSources({...target,sources:[deliveries[0].expectedHead]}), {code:'project_forbidden'});
    await query("update users set pending_deletion=false, status='disabled', deleted_at=now() where id=$1", [user.id]);
    await assert.rejects(memory.search(lookup), { code: 'project_forbidden' });
  }));

test('native comment and requirement rebinding serialize with memory adoption', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryfence', async db => {
    const { query, project, req, target, memory } = await bindingFixture(db);
    const newFeature = await query("insert into features(project_id,title,status) values($1,'Other','active') returning code", [project.id]);
    const proposal = { ...target, ...await memory.inspect(target), sessionId: 'session', eventId: 'proposal',
      sourceText: '我建议退款超过七天转人工审核', parts: [{ kind: 'discussion', text: '我建议退款超过七天转人工审核' }] };
    const captured = await memory.capture(proposal);
    const native = [];
    try {
      await db.transaction(async tx => {
        await lockAggregate(tx, 'project', BigInt(project.id));
        const { pid } = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0];
        native.push(createRequirementUseCases(db).updateRequirement({ ...target, featureCode: newFeature.code }));
        native.push(createRequirementCollaborationUseCases(db).addTopicEntry({ ...target, entryType: 'comment', content: '需要测试覆盖' }));
        const deadline = Date.now() + 8000;
        while (true) {
          const { count } = await query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event='advisory' and $1=any(pg_blocking_pids(pid))", [pid]);
          if (count === 2) break;
          assert.ok(Date.now() < deadline, 'Both native writers must reach the project fence before adoption');
          await delay(15);
        }
        await createMemorySliceUseCases(tx).capture({ ...proposal, expectedHead: captured.expectedHead, eventId: 'adoption',
          referenceText: '是否采纳《退款超过七天转人工审核》？', sourceText: '就按这个方案做', parts: [{ kind: 'adopt', text: '就按这个方案做' }] });
      });
      const [binding, comment] = await Promise.all(native);
      assert.equal(binding.error?.code, 'snapshot_conflict');
      assert.equal(comment.ok, true);
      assert.deepEqual(await query('select current_revision from requirements where id=$1', [req.id]), { current_revision: 2 });
      assert.deepEqual(await query('select status from requirement_topics where code=$1', [target.topicCode]), { status: 'decided' });
      const adopted = (await memory.search({ ...target, query: '超过七天' })).find(r => r.state === 'confirmed');
      const current = await memory.brief({ ...target, scope: 'project' });
      assert.deepEqual(current.map(row => [row.source, row.state]), [[adopted.source, 'confirmed']]);
      assert.equal(adopted?.topicCode, target.topicCode);
      assert.equal(adopted?.requirementCode, target.requirementCode);
      assert.equal(adopted?.sourceRevision, 2);
      assert.ok(adopted);
      const feedback = await createRequirementCollaborationUseCases(db).addTopicEntry({
        ...target, entryType: 'feedback', content: '这项决定需要重新讨论',
      });
      assert.ok(feedback.ok);
      assert.deepEqual(await memory.brief({ ...target, scope: 'project' }), []);
      assert.equal((await memory.search({ ...target, query: '超过七天' })).find(r => r.source === adopted.source)?.topicStatus, 'reopened');
      const replacement = await createRequirementCollaborationUseCases(db).addTopicEntry({ ...target, entryType: 'decision',
        content: '改为三天后审核', supersedesEntryCode: adopted.source });
      assert.ok(replacement.ok);
      assert.ok((await memory.search({ ...target, query: '超过七天' })).every(r => r.source !== adopted.source));
    } finally {
      await Promise.allSettled(native);
    }
  }));

test('a bare confirmation requires an exact conversational reference; explicit adoption must name the criterion', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryreference', async db => {
    const { query, target, memory } = await bindingFixture(db);
    const proposal = '我建议退款超过七天进入人工审核。';
    const criterion = '退款超过七天进入人工审核';
    const event = { ...target, ...await memory.inspect(target), sessionId: 'reference', eventId: 'proposal' };
    await memory.capture({ ...event, sourceText: proposal, parts: [{ kind: 'discussion', text: proposal }] });
    const confirm = { ...event, ...await memory.inspect(target), eventId: 'confirm' };
    const attempt = (text, referenceText) => memory.capture({ ...confirm, sourceText: text, referenceText, parts: [{ kind: 'adopt', text }] });
    for (const reference of [undefined, '退款三天后进入人工审核。', `这是另一个问题；是否采纳《${criterion}》？`, '刚才说的方案']) {
      await assert.rejects(attempt('就按这个方案做。', reference), { code: 'memory_ambiguous' });
    }
    await assert.rejects(attempt('确认采纳：退款三天后进入人工审核。', criterion), { code: 'memory_ambiguous' });
    await assert.rejects(attempt('就按这个方案做。', 'a'.repeat(1001)), { code: 'memory_invalid' });
    assert.deepEqual(await query('select count(*)::int as count from memory_capture_receipts'), { count: 1 });
    const named = await attempt(`确认采纳：${criterion}。`, undefined);
    assert.equal(named.expectedRevision, 2);
    await assert.rejects(attempt(`确认采纳：${criterion}。`, criterion), { code: 'memory_event_conflict' });
  }));

test('post-decision observations stay in the brief before indexing without promoting them to a decision', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryobservations', async db => {
    const { query, target, memory } = await bindingFixture(db);
    let eventId = 0;
    const capture = async (text, kind = 'discussion') => memory.capture({
      ...target, ...await memory.inspect(target), sessionId: 'observations', eventId: String(++eventId),
      sourceText: text, parts: [{ kind, text }],
    });
    const proposal = await capture('我建议工作台查询超时设置为8秒。');
    const decision = await capture('确认采纳：工作台查询超时设置为8秒。', 'adopt');
    const release = await capture('演练记录：staging 曾经运行v1，后来部署v2，现在运行v2。');
    const releaseSource = release.items[0].source;
    const afterRelease = await memory.brief({ ...target, scope: 'project' });
    assert.deepEqual(new Set(afterRelease.map(row => row.source)), new Set([decision.items[0].source, releaseSource]));
    const observed = afterRelease.find(row => row.source === releaseSource);
    assert.equal(observed.state, 'discussed');
    assert.equal(observed.topicStatus, 'decided');
    assert.equal(observed.sourceRevision, decision.expectedRevision);
    assert.ok(afterRelease.every(row => row.source !== proposal.items[0].source));
    assert.deepEqual(await query("select count(*)::int as count from memory_projection_jobs where status='synced'"), { count: 0 });
    const withdrawn = await createRequirementCollaborationUseCases(db).withdrawTopicEntry({
      entryCode: releaseSource, principalCode: target.principalCode, reason: '后续回滚记录替代当前环境状态。',
    });
    assert.equal(withdrawn.ok, true);
    const rollback = await capture('演练记录：staging 因回归完成回滚，现在运行v1；v2曾成功部署属于历史。');
    const afterRollback = await memory.brief({ ...target, scope: 'project' });
    assert.deepEqual(new Set(afterRollback.map(row => row.source)), new Set([decision.items[0].source, rollback.items[0].source]));
    assert.deepEqual(await memory.readSources({ ...target, sources: [releaseSource] }), []);
    assert.deepEqual(await query('select current_revision from requirements where code=$1', [target.requirementCode]), { current_revision: decision.expectedRevision });
    const laterDecision = await createRequirementCollaborationUseCases(db).addTopicEntry({
      ...target, entryType: 'decision', content: '后续确认需要重新验证环境状态。',
    });
    assert.equal(laterDecision.ok, true);
    // A native decision need not advance the requirement revision. Its earlier
    // discussion must still be excluded by timeline order, not just revision.
    assert.deepEqual(await memory.brief({ ...target, scope: 'project' }), []);
    const newer = await capture('演练记录：后续验证确认staging仍运行v1。');
    assert.deepEqual((await memory.brief({ ...target, scope: 'project' })).map(row => row.source), [newer.items[0].source]);
    const revision = await createRequirementUseCases(db).updateRequirement({
      ...target, title: 'Next observation revision',
    });
    assert.equal(revision.ok, true);
    assert.deepEqual(await memory.brief({ ...target, scope: 'project' }), []);
    await capture('演练记录：当前修订再次验证环境。');
    assert.equal((await memory.brief({ ...target, scope: 'project' })).length, 1);
    await query("update requirement_topics set status='archived' where code=$1", [target.topicCode]);
    assert.deepEqual(await memory.brief({ ...target, scope: 'project' }), []);
  }));

test('only an affirmative first-person account declaration is reusable in another project', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryscope', async db => {
    const { query, target, memory } = await bindingFixture(db);
    const other = await query("select code from projects where name='Fixture B'");
    const event = { ...target, ...await memory.inspect(target), sessionId: 'scope' };
    const allowed = ['在所有项目中我习惯先读摘要。', '无论哪个项目，我都先读摘要。', '跨项目我都偏好先读摘要。'];
    const local = ['我习惯先读摘要，希望将来能适用于所有项目。', '在所有项目中我习惯先读摘要，但项目甲除外。',
      '在所有项目中我习惯不跳过摘要。', '跨项目我都只在评审时先读摘要。', '跨项目我都遇到回归时先读摘要。'];
    for (const [i, text] of [...allowed, ...local].entries()) {
      await memory.capture({ ...event, eventId: String(i), sourceText: text, parts: [{ kind: 'preference', text, applicability: 'account' }] });
    }
    const isolated = '在所有项目中我习惯先读特殊摘要。';
    await memory.capture({ ...event, eventId: 'qualified', sourceText: isolated + '不过甲项目例外。', parts: [{ kind: 'preference', text: isolated }] });
    const legacy = '我在开发项目会先读摘要，并不适用于所有项目。';
    await memory.capture({ ...event, eventId: 'legacy', sourceText: legacy, parts: [{ kind: 'preference', text: legacy }] });
    await query("update memory_fragments set applicability='account' where text=$1", [legacy]);
    const shared = await memory.search({ ...target, projectCode: other.code, scope: 'personal', query: '摘要' });
    assert.deepEqual(shared.map(i => i.text).sort(), allowed.sort());
    const elsewhere = await memory.brief({ ...target, projectCode: other.code, scope: 'personal' });
    assert.deepEqual(elsewhere.map(i => i.text).sort(), allowed.sort());
    assert.ok(shared.every(row => row.applicability === 'account' && !('topicCode' in row) && !('requirementCode' in row)));
    const own = await memory.search({ ...target, scope: 'personal', query: '摘要' });
    const revalidated = await memory.readSources({ ...target, projectCode: other.code, sources: own.map(row => row.source) });
    assert.deepEqual(revalidated.map(row => row.text).sort(), allowed.sort());
    assert.ok(revalidated.every(row => row.applicability === 'account' && !('topicCode' in row)));
    await assert.rejects(memory.readSources({ ...target, sources: [] }), { code: 'memory_invalid' });
    await assert.rejects(memory.readSources({ ...target, sources: Array(41).fill(own[0].source) }), { code: 'memory_invalid' });
    await assert.rejects(memory.readSources({ ...target, sources: ['not-a-source'] }), { code: 'memory_invalid' });
  }));
