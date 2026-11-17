// Opt-in held-out handoff scenarios and negative controls. Invoke through the model-attesting Magpie runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeHandoffTurn, collectHandoffTurn, retrievalCosts, writeBlindHandoffPacket } from './native-memory-defect-handoff.mjs';
import { withHandoffFixture } from './native-memory-handoff-fixture.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const folder=path.join(repo,'docs/experiments/memory-harness-pilot/defect-handoff');
const cli=path.join(repo,'apps/cli/dist/index.js');
const sha=text=>createHash('sha256').update(text).digest('hex');
const resultFile=path.join(folder,'results-diversity.json');

function auditForbiddenEvidence(runs, controls) {
  const blocked = new Set(controls.questions.flatMap(q => q.forbiddenSourceIds ?? []));
  const literals = controls.questions.flatMap(q => q.forbiddenLiterals ?? []);
  const exposedRuns = runs.filter(run =>
    run.seenSourceIds.some(id => blocked.has(id)) ||
    run.citedAndRead.some(id => blocked.has(id)) ||
    run.citedButNotRead.some(id => blocked.has(id)) ||
    literals.some(literal => run.answer.includes(literal)));
  assert.equal(exposedRuns.length, 0, 'Forbidden evidence was exposed in at least one member turn');
  return {checkedMemberTurns: runs.length, forbiddenSourcesChecked: blocked.size,
    forbiddenLiteralCount: literals.length, exposedMemberTurns: exposedRuns.length};
}

async function run() {
  assert.equal(process.env.TSP_EVAL_MODEL,'workbuddy/deepseek-v4.1-flash');
  assert.equal(process.env.TSP_EVAL_FAMILY,'deepseek-v4.1-flash');
  assert.equal(process.env.TSP_PROBE_DSH_PROFILE,'headless');
  assert.ok(process.env.TSP_EVAL_GATEWAY_TOKEN && !process.env.TSP_PROBE_DSH_GUIDANCE);
  const names=['case.json','diversity-cases.json','diversity-controls.json'];
  const bytes=await Promise.all(names.map(name=>readFile(path.join(folder,name))));
  const [history,library,controls]=bytes.map(buf=>JSON.parse(buf));
  const sources=[...history.sources,...library.cases.flatMap(c=>c.sources),...controls.sources]
    .sort((a,b)=>(a.observedAt??'9999').localeCompare(b.observedAt??'9999'));
  const questions=[...library.cases.map(c=>({...c,group:'defect'})),...library.variants.map(c=>({...c,group:'evidence-boundary'})),
    ...controls.questions.map(c=>({...c,group:'control'}))];
  const ids=new Set(sources.map(s=>s.id));
  assert.equal(ids.size,sources.length,'Source labels must be globally unique in the shared project');
  assert.equal(new Set(questions.map(q=>q.id)).size,questions.length);
  for (const q of questions) {
    assert.ok(/^[a-z0-9-]+$/i.test(q.id) && q.prompt && q.rubric.length);
    for (const rule of q.rubric) assert.ok(Array.isArray(rule.sourceIds) && rule.sourceIds.every(id=>ids.has(id)));
  }
  const corpus={id:'handoff-diversity',title:'TeamSynergy 软件维护交接',sources};
  const system=execFileSync(process.execPath,[cli,'memory','guidance','--harness','dsh'],{encoding:'utf8',windowsHide:true}).trim()
    +'\n你是新接手本项目的软件维护成员。用中文直接回答用户当前问题。涉及项目或个人事实时，对每个关键判断引用实际读到的原始 source，区分测试、方案与真实实施；材料不足应明确说明。只问常识或算术则直接回答。';
  const began=new Date().toISOString();
  const evidence=await withHandoffFixture(corpus,async f=>{
    const withdrawn=[];
    for (const id of controls.withdrawBeforeTurns) {
      withdrawn.push({id,receipt:await f.withdrawTestProposal(id)});
    }
    const raw=[];
    // Each question runs sequential off/on or on/off; two different questions may run concurrently.
    for (let start=0;start<questions.length;start+=2) {
      const group=await Promise.allSettled(questions.slice(start,start+2).map(async (q,offset)=>{
        const turns=[];
        for (const enabled of (start+offset)%2===0?[false,true]:[true,false]) {
          const turn=await collectHandoffTurn(f,{pair:1,enabled,prompt:q.prompt,system});
          turns.push({q,turn});
        }
        return turns;
      }));
      for (const res of group) {
        if (res.status==='rejected') throw res.reason;
        raw.push(...res.value);
      }
    }
    const replayCache=new Map();
    const runs=[];
    for (const {q,turn} of raw) {
      const run=await analyzeHandoffTurn(f,turn,q.rubric,replayCache);
      run.caseId=q.id; run.group=q.group; run.prompt=q.prompt;
      run.retrievalCosts=retrievalCosts(run,corpus);
      const blocked=q.forbiddenSourceIds??[];
      run.negativeChecks={forbiddenSourceReturned:blocked.some(id=>run.seenSourceIds.includes(id)),
        forbiddenSourceCited:blocked.some(id=>run.citedAndRead.includes(id)||run.citedButNotRead.includes(id)),
        forbiddenLiteralExposed:(q.forbiddenLiterals??[]).some(value=>turn.output.answer.includes(value)),
        ...(q.id==='no-memory-needed'?{exactArithmetic:/^\s*407[。.!]?\s*$/u.test(run.answer),zeroMemoryRequests:!run.calls.length}: {})};
      if (run.negativeChecks.forbiddenSourceReturned || run.negativeChecks.forbiddenLiteralExposed) {
        throw Error('Forbidden source or value reached the member: '+q.id);
      }
      runs.push(run);
    }
    return {sourceMap:f.sources.filter(s=>s.scope!=='personal' || s.owner!=='alice')
      .map(s=>({id:s.id,source:s.source,scope:s.scope,sha256:s.sha256,locator:s.locator??null})),
      projection:f.projectionSummary,withdrawn,runs};
  });
  const report={host:'DSH 0.2.1-rc.2 headless',model:process.env.TSP_EVAL_MODEL,startedAt:began,endedAt:new Date().toISOString(),
    inputHashes:Object.fromEntries(names.map((name,i)=>[name,sha(bytes[i])])),system,systemSha256:sha(system),
    questionCount:questions.length,sharedSourceCount:sources.length,uniqueMemberSessions:evidence.runs.length,
    budget:{maxTokens:4096,turnTimeoutMs:180000,maxToolCalls:24},
    design:'One isolated project with B-05, A-02, B-02 and the withdrawal/ownership controls; same member and corpus in both arms. Two independent sessions with random, opaque working directories per question; alternating order.',
    fixtureCleaned:true,globalAccessAudit:auditForbiddenEvidence(evidence.runs,controls),...evidence};
  await writeFile(resultFile,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({questions:questions.length,runs:report.runs.length,fixtureCleaned:true}));
}

if (process.argv[2]==='--blind') {
  const report=JSON.parse(await readFile(resultFile,'utf8'));
  console.log(JSON.stringify(await writeBlindHandoffPacket({runs:report.runs})));
} else if (process.argv[2]==='--verify-access') {
  const report=JSON.parse(await readFile(resultFile,'utf8'));
  const bytes=await readFile(path.join(folder,'diversity-controls.json'));
  assert.equal(sha(bytes),report.inputHashes['diversity-controls.json']);
  report.globalAccessAudit=auditForbiddenEvidence(report.runs,JSON.parse(bytes));
  await writeFile(resultFile,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.globalAccessAudit));
} else await run();
