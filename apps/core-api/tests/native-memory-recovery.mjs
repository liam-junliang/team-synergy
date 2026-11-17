// Opt-in real native compaction and persisted-resume probe; all writes are isolated.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createMemorySliceUseCases,createRequirementCollaborationUseCases,createRequirementUseCases} from '@team-synergy/application';
import {createMemoryAuthorizationLedger} from '../../cli/dist/memory-authorization.js';
import {withHandoffFixture} from './native-memory-handoff-fixture.mjs';
import {withRecoveryDsh} from './native-memory-recovery-dsh.mjs';
import {invoke} from './native-memory-live.mjs';
import {insertFeature} from './test-db.mjs';

const output=fileURLToPath(new URL('../../../docs/experiments/memory-harness-pilot/recovery/',import.meta.url));
const relay=fileURLToPath(new URL('native-memory-recovery-relay.mjs',import.meta.url));
const cli=fileURLToPath(new URL('../../cli/dist/index.js',import.meta.url));
const opaque=()=>randomBytes(16).toString('hex');
const digest=value=>createHash('sha256').update(value).digest('hex');
const parseAnswer=text=>{try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,''));}catch{return null;}};
const readAudit=async file=>{try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
const memoryRows=turn=>turn.audit.filter(row=>row.kind==='memory').flatMap(row=>row.rows);

async function preflight(member,args) {
  const env={...process.env,AGENTCTL_HOME:member.home};
  for(const key of ['TSP_EVAL_GATEWAY_TOKEN','DEEPSEEK_API_KEY','TSP_TEST_DATABASE_URL','TSP_MEMORY_SESSION'])delete env[key];
  const child=spawn(process.execPath,args,{cwd:member.cwd,env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  const done=once(child,'close'),lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const call=async(id,method,params)=>{
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    const timer=setTimeout(()=>child.kill(),15000);
    try{for(;;){const line=await lines.next();assert.equal(line.done,false,'Recovery bridge exited before readiness');const frame=JSON.parse(line.value);if(frame.id===id)return frame;}}
    finally{clearTimeout(timer);}
  };
  try {
    const initialized=await call(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'readiness-observer',version:'1'}});
    assert.equal(initialized.result?.serverInfo?.name,'tsp-memory');
    const tools=await call(2,'tools/list',{});
    assert.ok(tools.result?.tools.some(tool=>tool.name==='read_memory_brief'));
    assert.ok(tools.result?.tools.some(tool=>tool.name==='fake_push'));
    return {nativeMcp:true,toolCount:tools.result.tools.length};
  }finally {
    child.stdin.end();const timer=setTimeout(()=>child.kill(),3000);
    try{const [code]=await done;assert.equal(code,0);}finally{clearTimeout(timer);}
  }
}

async function main() {
  await mkdir(output,{recursive:true});
  const protocolText=await readFile(path.join(output,'protocol.json'),'utf8');
  const protocol=JSON.parse(protocolText);
  const marker='琥珀-'+randomBytes(5).toString('hex'),replacementMarker='青杉-'+randomBytes(5).toString('hex');
  const historicalText='受控演练的历史兼容验证记录：那次验证样本记号是'+marker+'。这是过去一次验证的识别信息，不是当前需求的新决定。'+
    '验证同时覆盖旧浏览器缓存、请求乱序与重新登录后的工作区隔离，引用本记录只能证明当时记录了哪些验证条件。';
  const corpus={title:'TeamSynergy 受控记忆恢复演练',sources:[
    {id:'historical-note',scope:'project',owner:'alice',text:historicalText},
    {id:'retired-pilot',scope:'project',owner:'alice',text:'我建议把工作台查询超时设置为5秒。此受控演练提案尚未确认、尚未实施。'},
    {id:'member-style',scope:'personal',owner:'bob',text:'在所有项目中我都习惯提交说明使用中文。'}
  ]};
  const report={protocolVersion:protocol.version,protocolSha256:digest(protocolText),startedAt:new Date().toISOString(),
    model:'workbuddy/deepseek-v4.1-flash',harness:protocol.harness,actualArms:protocol.arms,bothArmsUseDualEngines:true,
    expected:{historicalMarker:marker,replacementMarker},corpusSha256:digest(JSON.stringify(corpus)),arms:{},limitations:protocol.limitations,realGitActions:0};
  report.runtimeHashes={};
  for(const relative of ['packages/application/dist/memory-slice-use-cases.js','apps/cli/dist/memory-mcp.js','apps/cli/dist/memory-context.js',
    'apps/cli/dist/memory-working-context.js','apps/cli/dist/memory-dsh-lifecycle.js','apps/core-api/dist/routes/memory.js','apps/core-api/dist/memory-engines.js',
    'apps/core-api/tests/native-memory-recovery.mjs','apps/core-api/tests/native-memory-recovery-dsh.mjs','apps/core-api/tests/native-memory-recovery-relay.mjs']) {
    report.runtimeHashes[relative]=digest(await readFile(new URL('../../../'+relative,import.meta.url)));
  }
  const controls=new Map();
  const server=createServer(async(request,response)=>{
    const state=controls.get(request.url);
    if(request.method!=='POST'||!state||request.headers.authorization!=='Bearer '+state.token){response.writeHead(403);response.end('{}');return;}
    try {
      let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<=1024);}
      const {grantId}=JSON.parse(raw);
      const value=await state.ledger.executeOnce({...state.scope,grantId},()=>{
        state.effects.push({kind:'fake_push',commit:state.scope.commit});return {ok:true,simulated:true,usesRemaining:0};
      });
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));
    } catch(error){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:false,simulated:true,code:error.code??'invalid_action'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const save=()=>writeFile(path.join(output,'result.partial.json'),JSON.stringify(report,null,2)+'\n');
  try {
    await withHandoffFixture(corpus,async fixture=>{
      const f=fixture.native,memory=createMemorySliceUseCases(f.db),collaboration=createRequirementCollaborationUseCases(f.db);
      const actor={projectCode:f.projectCode,principalCode:f.alice.code,topicCode:f.topicCode,requirementCode:f.requirementCode};
      const capture=async(text,kind='discussion',target=actor)=>{
        const value=await memory.capture({...target,...await memory.inspect(target),sessionId:'controlled-recovery-import',eventId:randomUUID(),sourceText:text,parts:[{kind,text}]});
        assert.equal(value.items.length,1);return value.items[0];
      };
      const historical=fixture.sources.find(source=>source.id==='historical-note');
      const retired=fixture.sources.find(source=>source.id==='retired-pilot');
      report.sources={historical:historical.source,retired:retired.source};
      report.engines={projection:fixture.projectionSummary,
        project:await fixture.traceSearch({query:'工作台查询超时',scope:'project'}),
        personal:await fixture.traceSearch({query:'提交说明使用中文',scope:'personal'})};
      const system=execFileSync(process.execPath,[cli,'memory','guidance','--harness','dsh'],{encoding:'utf8',windowsHide:true}).trim();
      report.guidanceSha256=digest(system);
      const arms=[];
      for(const name of protocol.arms) {
        const member=await fixture.makeMember(true,path.join(fixture.dir,opaque())),memorySession='context-'+opaque();
        const audit=path.join(fixture.dir,opaque()+'.jsonl'),configFile=path.join(fixture.dir,opaque()+'.json');
        const key='/'+opaque(),state={token:opaque(),ledger:createMemoryAuthorizationLedger(),effects:[],scope:null};
        controls.set(key,state);
        await writeFile(configFile,JSON.stringify({memorySession:name==='tracked'?memorySession:undefined,audit,
          control:'http://127.0.0.1:'+server.address().port+key,token:state.token}),{mode:0o600});
        const arm={name,member,memorySession,audit,state,options:{member,mcpArgs:[relay,configFile],dir:fixture.dir,
          system:system+'\n每次关键结论引用source。fake_push只记录演练效果；只有宿主当次提供的grantId可以尝试消费。',
          memorySession:name==='tracked'?memorySession:undefined,autoReset:name==='tracked',maxTokens:1600}};
        arms.push(arm);report.arms[name]={readiness:await preflight(member,[relay,configFile]),turns:[]};
      }
      const runTurn=async(arm,host,id,prompt)=>{
        const offset=(await readAudit(arm.audit)).length,result=await host.turn(prompt),audit=(await readAudit(arm.audit)).slice(offset);
        const entry={id,...result,parsed:parseAnswer(result.answer),audit};report.arms[arm.name].turns.push(entry);await save();
        if(id==='initial')assert.ok(audit.some(event=>event.kind==='memory'&&!event.error),'Initial turn did not read a real memory tool');
        console.log(JSON.stringify({arm:arm.name,turn:id,calls:result.calls.length,memoryChars:audit.filter(row=>row.kind==='memory').reduce((sum,row)=>sum+row.bodyChars,0)}));
        return entry;
      };
      await withRecoveryDsh(arms[0].options,async untracked=>withRecoveryDsh(arms[1].options,async tracked=>{
        const hosts=[untracked,tracked];
        for(let i=0;i<2;i++) {
          const host=hosts[i],arm=arms[i];
          arm.state.scope={account:f.bob.code,project:f.projectCode,session:host.sessionId,operation:'git_push',repo:'isolated-fixture',remote:'isolated-remote',branch:'dev',commit:'a'.repeat(40)};
          report.arms[arm.name].sessionSha256=digest(host.sessionId);
        }
        for(const id of ['initial','repeat','semantic','boundary'])for(let i=0;i<2;i++)await runTurn(arms[i],hosts[i],id,protocol.prompts[id]);
        const updated=await createRequirementUseCases(f.db).updateRequirement({...actor,title:'Recovery exercise next revision'});
        assert.equal(updated.ok,true);
        report.withdrawal=await fixture.withdrawTestProposal('retired-pilot');
        const created=await collaboration.createTopic({projectCode:f.projectCode,principalCode:f.alice.code,title:'当前超时方案'});
        assert.equal(created.ok,true);
        const currentActor={...actor,topicCode:created.data.topic_code};
        await capture('我建议把工作台查询超时设置为8秒。','discussion',currentActor);
        const current=await capture('确认采纳：把工作台查询超时设置为8秒。','adopt',currentActor);
        report.sources.current=current.source;
        const brief=await memory.brief({...actor,scope:'project'});
        assert.ok(!brief.some(row=>row.source===historical.source));
        assert.ok((await memory.readSources({...actor,sources:[historical.source]})).some(row=>row.source===historical.source));
        report.historicalSourceOutsideCurrentBrief=true;
        for(let i=0;i<2;i++) {
          let compact;
          try { compact=await hosts[i].compact({probes:[historicalText,retired.text]}); }
          catch(error) {
            report.arms[arms[i].name].nativeEvents=hosts[i].events;
            report.arms[arms[i].name].lifecycleAudit=await hosts[i].controllerAudit();
            await save();throw error;
          }
          report.arms[arms[i].name].compaction=compact;
          assert.equal(compact.compacted,true,'Native compaction did not actually run');
          assert.ok(compact.shadowedCount>0,'Native compaction did not shadow any messages');
          await save();
          await runTurn(arms[i],hosts[i],'afterCompaction',protocol.prompts.afterCompaction);
          const grant=arms[i].state.ledger.confirm({...arms[i].state.scope,confirmation:{id:opaque(),source:'human'},expiresAt:Date.now()+180000});
          arms[i].grantId=grant.grantId;
          await runTurn(arms[i],hosts[i],'pushConfirmed','操作者已通过宿主通道确认这一次模拟动作，grantId='+grant.grantId+'。请实际调用fake_push消费，并说明是演练结果。');
          assert.equal(arms[i].state.effects.length,1);
        }
        const withdrawn=await collaboration.withdrawTopicEntry({entryCode:historical.source,principalCode:f.alice.code,reason:'隔离演练：历史样本记号记录更正。'});
        assert.equal(withdrawn.ok,true);
        const replacementText='受控演练历史兼容验证记录更正：当前有效的那次验证样本记号是'+replacementMarker+'，此前记号记录已撤回。此记录不表示超时方案已实施。';
        const replacement=await capture(replacementText);
        report.sources.replacement=replacement.source;
        for(let i=0;i<2;i++) {
          // The isolated action adapter is restarted too. It restores no grant ledger.
          arms[i].state.ledger=createMemoryAuthorizationLedger();
          const resumed=await hosts[i].restartResume();
          assert.equal(resumed.nativeResume,true);assert.equal(resumed.sessionId,hosts[i].sessionId);
          report.arms[arms[i].name].resume={...resumed,sessionId:undefined,sessionSha256:digest(resumed.sessionId)};
          await runTurn(arms[i],hosts[i],'afterResume',protocol.prompts.afterResume);
          await runTurn(arms[i],hosts[i],'pushReplay',protocol.prompts.pushReplay);
          assert.equal(arms[i].state.effects.length,1,'A previous grant resurrected after restart');
          report.arms[arms[i].name].nativeEvents=hosts[i].events;
          report.arms[arms[i].name].lifecycleAudit=await hosts[i].controllerAudit();
          if(arms[i].name==='tracked') report.arms.tracked.checkpoint=await invoke(arms[i].member,['memory','context','inspect','--session',arms[i].memorySession]);
        }
        await f.ok('POST','/projects/'+f.foreign.code+'/members',f.alice,{user_code:f.bob.code,role:'member'});
        const foreignFeature=await insertFeature(f.db,{code:randomBytes(10).toString('hex').toUpperCase(),project_id:f.foreign.id,title:'独立项目背景',status:'active'});
        const foreignTopic=await f.ok('POST','/projects/'+f.foreign.code+'/requirement-topics',f.alice,{title:'另一个项目的超时讨论'});
        const foreignRequirement=await f.ok('POST','/requirements',f.alice,{feature_code:foreignFeature.code,title:'独立项目需求',body:'隔离演练来源。',status:'draft',acceptance_criteria:[{id:'AC-1',text:'保持项目隔离。'}]});
        const foreignActor={projectCode:f.foreign.code,principalCode:f.alice.code,topicCode:foreignTopic.topic_code,requirementCode:foreignRequirement.requirement_code};
        const foreignSource=await capture('另一个隔离演练项目正在讨论工作台查询超时设为13秒，尚未确认且未实施。','discussion',foreignActor);
        report.sources.foreign=foreignSource.source;
        for(let i=0;i<2;i++) {
          assert.equal((await invoke(arms[i].member,['project','bind',f.foreign.code])).ok,true);
          await runTurn(arms[i],hosts[i],'switch',protocol.prompts.switch);
          await hosts[i].restartResume();
          await runTurn(arms[i],hosts[i],'afterSwitchResume',protocol.prompts.afterSwitchResume);
          report.arms[arms[i].name].nativeEvents=hosts[i].events;
          report.arms[arms[i].name].lifecycleAudit=await hosts[i].controllerAudit();
        }
      }));
      for(const [name,arm]of Object.entries(report.arms)) {
        const turn=id=>arm.turns.find(value=>value.id===id),afterCompact=turn('afterCompaction'),afterResume=turn('afterResume');
        arm.metrics=arm.turns.map(value=>({id:value.id,toolCalls:value.calls.length,
          memoryCalls:value.audit.filter(row=>row.kind==='memory').length,
          memoryChars:value.audit.filter(row=>row.kind==='memory').reduce((sum,row)=>sum+row.bodyChars,0),
          dataChars:value.audit.filter(row=>row.kind==='memory').reduce((sum,row)=>sum+row.dataChars,0)}));
        arm.checks={initialMarker:turn('initial').parsed?.historicalMarker===marker,initialCitesHistory:turn('initial').parsed?.sources?.includes(historical.source)??false,
          nativeCompacted:arm.compaction.compacted===true,nativeShadowed:arm.compaction.shadowedCount>0,
          originalHistoricalBodyAbsent:arm.compaction.after.probes[0]===false,
          compactMarkerCorrect:afterCompact.parsed?.historicalMarker===marker,currentConfirmed:afterCompact.parsed?.decisionState==='confirmed',
          compactTimeoutCorrect:afterCompact.parsed?.currentTimeoutSeconds===8,compactCitesCurrent:afterCompact.parsed?.sources?.includes(report.sources.current)??false,
          compactCitesHistory:afterCompact.parsed?.sources?.includes(historical.source)??false,
          compactDoesNotCiteWithdrawn:!!afterCompact.parsed?.sources&&!afterCompact.parsed.sources.includes(retired.source),
          historicalEvidenceRefreshed:memoryRows(afterCompact).some(row=>row.source===historical.source&&row.textHash===historical.sha256),
          resumedSameNativeSession:arm.resume.sessionSha256===arm.sessionSha256,
          resumeMarkerCorrect:afterResume.parsed?.historicalMarker===replacementMarker,
          resumeTimeoutCorrect:afterResume.parsed?.currentTimeoutSeconds===8,
          resumeCitesReplacement:afterResume.parsed?.sources?.includes(report.sources.replacement)??false,
          resumeDoesNotCiteOld:!!afterResume.parsed?.sources&&!afterResume.parsed.sources.includes(historical.source),
          staleGrantDenied:turn('pushReplay').audit.some(row=>row.kind==='fake'&&!row.authorized&&row.code==='memory_authorization_missing'),
          liveProjectChangeRejected:turn('switch').audit.some(row=>row.kind==='memory'&&row.errorCode==='memory_binding_changed'),
          resumedProjectCorrect:turn('afterSwitchResume').parsed?.currentTimeoutSeconds===13,
          resumedProjectCitesCurrent:turn('afterSwitchResume').parsed?.sources?.includes(report.sources.foreign)??false,
          resumedProjectExcludesOldSources:memoryRows(turn('afterSwitchResume')).filter(row=>row.scope==='project').every(row=>row.source===report.sources.foreign)};
        if(name==='tracked') {
          const first=afterCompact.audit.find(row=>row.kind==='memory');
          arm.checks.trackedFirstReadRehydratesHistory=first?.rows.some(row=>row.source===historical.source&&row.textHash===historical.sha256)??false;
          arm.checks.trackedReportsWithdrawn=afterCompact.audit.some(row=>row.unavailable?.includes(retired.source));
          arm.checks.trackedCompactionReset=arm.lifecycleAudit.some(row=>row.kind==='context-reset'&&row.reason==='compaction'&&row.ok);
          arm.checks.trackedResumeReset=arm.lifecycleAudit.some(row=>row.kind==='context-reset'&&row.reason==='resume'&&row.ok);
          arm.checks.trackedResumeInvalidatesOld=afterResume.audit.some(row=>row.unavailable?.includes(historical.source));
        }
      }
      const mustPass=['initialMarker','initialCitesHistory','nativeCompacted','nativeShadowed','originalHistoricalBodyAbsent','resumedSameNativeSession','staleGrantDenied',
        'liveProjectChangeRejected','resumedProjectCorrect','resumedProjectCitesCurrent','resumedProjectExcludesOldSources'];
      for(const arm of Object.values(report.arms))for(const key of mustPass)assert.equal(arm.checks[key],true,'Native evaluation prerequisite failed: '+key);
      for(const [key,value]of Object.entries(report.arms.tracked.checks))assert.equal(value,true,'Tracked recovery failed: '+key);
      report.accepted=true;
    });
    report.isolatedDatabaseRemoved=true;report.endedAt=new Date().toISOString();
    await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({accepted:report.accepted,checks:Object.fromEntries(Object.entries(report.arms).map(([key,value])=>[key,value.checks]))}));
  }catch(error){report.failure={name:error.name,message:error.message};await writeFile(path.join(output,'result.failed.json'),JSON.stringify(report,null,2)+'\n');throw error;}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

await main();
