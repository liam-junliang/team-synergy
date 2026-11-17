import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareArchitectureGroundingRepairs, applyArchitectureGroundingRepairs, ARCHITECTURE_SOURCE_DEFINITION_PREFIX } from '../dist/code-analysis-semantic-repair.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';
import { createSemanticModelClient, semanticInferencePolicy } from '../dist/code-analysis-semantic-model.js';
const evidence=[{path:'src/operation.ts',line_start:1,line_end:3}];
function fixture(){
 const rule={description:'只有原操作满足条件才继续。',evidence:structuredClone(evidence)};
 const architecture={description:'项目阅读入口。',languages:['TypeScript'],frameworks:[],modules:[{id:'module:one',name:'首个职责',summary:'原操作可以继续。所有动作都需要特权。',state_owners:['当前状态'],user_purposes:['阅读当前状态'],business_rules:[structuredClone(rule),structuredClone(rule)],evidence:structuredClone(evidence)},{id:'module:two',name:'另一个职责',summary:'未受影响的职责。',business_rules:[],evidence:structuredClone(evidence)}],capabilities:[{id:'capability:view',name:'阅读',summary:'阅读操作。',module_ids:['module:one'],business_rules:[structuredClone(rule)],evidence:structuredClone(evidence)}],flows:[{id:'flow:view',name:'阅读流程',summary:'先读取，再展示。',business_rules:[],steps:[{capability_id:'capability:view',description:'显示当前结果。',evidence:structuredClone(evidence)}],evidence:structuredClone(evidence)}],relations:[],unknowns:['原有未知必须保留。']};
 const origin={name:'仅原操作',responsibility:'不得泛化到其他动作',state_owners:[],user_purposes:[],related_paths:['src/operation.ts'],source_file_ids:[0],evidence:structuredClone(evidence)};
 const line=(node_id,rule_index,origin_scope_id)=>({node_id,rule_index,parent_rule_id:'OR-same',origin_scope_id,origin_scope:structuredClone(origin),description:rule.description,evidence:structuredClone(evidence),source_epistemic_status:'source_inference',epistemic_status:'source_inference'});
 return{architecture,lineage:[line('module:one',0,'OS-first'),line('module:one',1,'OS-second'),line('capability:view',0,'OS-first')]};
}
function narrative(architecture,field='modules.0.summary',node='module:one'){
 const text=field==='modules.0.summary'?architecture.modules[0].summary:architecture.flows[0].steps[0].description;
 let start=0;return text.split('。').filter(Boolean).map((part,index)=>{const span=part+'。',end=start+span.length,claim={id:`claim:${field}:${index}`,node_id:node,field:`${field}:${start}-${end}`,text:span,kind:'narrative',evidence:structuredClone(evidence),scope_context:{field,field_text:text,field_span:[start,end],name:'原操作职责'}};start=end;return claim;});
}
function witness(text='function operate(){ return false; }') {return{id:'GS-fixed',...evidence[0],file_sha256:'a'.repeat(64),text_sha256:semanticDigest(text),defines:['operate'],definition_complete:true,source_kind:'code',text};}
function feedback(claim,status='insufficient',sources=[]){return{id:claim.id,node_id:claim.node_id,field:claim.field,text_sha256:semanticDigest(claim.text),status,reason:'实际定义尚未提供足够支持，必须撤回扩大范围的肯定表述。',evidence:structuredClone(evidence),context_ids:['context:'+claim.id],snapshot_id:'b'.repeat(64),sources};}
function response(request,replacement='本节点提供相关源码详情的阅读入口。',decision='replace'){return{patches:request.input.targets.map(target=>({field:target.field,field_sha256:target.field_sha256,decision,replacement_text:replacement,unknowns:['原具体行为仍待源码依据确认。']}))};}
function responseIdentityCases(){return[
 {name:'duplicate field and missing coverage',path:'$.patches[1].field',change:raw=>{raw.patches[1]=structuredClone(raw.patches[0]);}},
 {name:'cross-target field hash',path:'$.patches[0].field_sha256',change:raw=>{raw.patches[0].field_sha256=raw.patches[1].field_sha256;}},
 {name:'per-target length',path:'$.patches[1].replacement_text',change:raw=>{raw.patches[1].replacement_text='x'.repeat(801);}},
 {name:'model supplied host prefix',path:'$.patches[0].replacement_text',change:raw=>{raw.patches[0].replacement_text=ARCHITECTURE_SOURCE_DEFINITION_PREFIX+'MODEL_VALUE_MUST_NOT_LEAK';}},
 {name:'empty replacement',path:'$.patches[0].replacement_text',change:raw=>{raw.patches[0].replacement_text='  ';}},
 {name:'withdrawal retains text',path:'$.patches[0].replacement_text',change:raw=>{raw.patches[0].decision='withdraw';raw.patches[0].replacement_text='MODEL_VALUE_MUST_NOT_LEAK';}},
];}
function twoTargetRequest(){const {architecture,lineage}=fixture(),claims=[...narrative(architecture),...narrative(architecture,'flows.0.steps.0.description','flow:view')];return{architecture,lineage,request:prepareArchitectureGroundingRepairs(architecture,claims,claims.map(claim=>feedback(claim)),lineage).requests[0]};}

test('model repair identity defects retain precise safe constraints for the existing single repair attempt',()=>{
 const {architecture,lineage,request}=twoTargetRequest(),inputHash=semanticDigest(request.input);
 for(const sample of responseIdentityCases()){
  const raw=response(request,'准确的有限范围说明。');sample.change(raw);
  assert.throws(()=>request.decode(raw),error=>{
   assert.equal(error.code,'code_analysis_model_invalid');assert.equal(error.details.reason,'architecture_field_repair_response_identity');assert.equal(error.details.repairable,true,sample.name);assert.ok(error.details.issue_paths.includes(sample.path),sample.name);assert.ok(error.details.schema_issues.some(issue=>issue.path===sample.path));assert.equal(JSON.stringify(error.details).includes('MODEL_VALUE_MUST_NOT_LEAK'),false);return true;
  });
 }
 const missing=response(request);missing.patches.pop();assert.throws(()=>request.decode(missing),error=>error.details.repairable===true&&error.details.issue_paths.includes('$.patches'));
 const patches=request.decode(response(request,'准确的有限范围说明。'));
 for(const change of [items=>{items[0].previous_sha256='f'.repeat(64);},items=>{items[0].field_sha256='f'.repeat(64);},items=>{items[0].node_id='module:two';}]){
  const forged=structuredClone(patches);change(forged);assert.throws(()=>applyArchitectureGroundingRepairs(architecture,forged,lineage,[]),error=>error.code==='code_analysis_model_invalid'&&error.details.repairable===false);
 }
 assert.equal(semanticDigest(request.input),inputHash,'host schema, prompt and cache task input stay unchanged');
});

test('each model repair identity defect is rejected uncached before exactly one successful model correction',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'tsp-repair-identity-'));
 t.after(()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('tsp-repair-identity-'));rmSync(directory,{recursive:true,force:true});});
 const {request}=twoTargetRequest(),model='deepseek-v4.1-flash';
 for(const [index,sample] of responseIdentityCases().entries()){
  const bad=response(request,'有限的源码说明。');sample.change(bad);const good=response(request,'已纠正的有限源码说明。'),cacheDirectory=path.join(directory,'case'+index,'cache'),runDirectory=path.join(directory,'case'+index,'run'),prompts=[];
  const client=createSemanticModelClient({config:{modelUrl:'http://model.invalid/v1',model,apiKey:''},snapshotId:'a'.repeat(64),engineIdentity:'exact-engine',runDirectory,cacheDirectory,fetchImpl:async(_url,options)=>{
   const prompt=JSON.parse(JSON.parse(options.body).messages[1].content);prompts.push(prompt);
   if(prompts.length===2){assert.equal(prompt.correction.reason,'architecture_field_repair_response_identity');assert.ok(prompt.correction.fields.includes(sample.path));assert.equal(JSON.stringify(prompt.correction).includes('MODEL_VALUE_MUST_NOT_LEAK'),false);assert.equal(existsSync(cacheFile),false,'invalid response must not be cached');}
   return new Response(JSON.stringify({model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(prompts.length===1?bad:good)}}]}),{status:200});
  }});
  const task={phase:'architecture-repair',input:request.input,inference_policy:semanticInferencePolicy('architecture-repair')},cacheFile=path.join(cacheDirectory,client.key(task)+'.json');
  const result=await client.call({phase:'architecture-repair',name:request.name,input:request.input,validate:request.decode});
  assert.equal(prompts.length,2,sample.name);assert.equal(result.value[0].replacement_text,good.patches[0].replacement_text);assert.deepEqual(JSON.parse(readFileSync(cacheFile,'utf8')).output,good);assert.deepEqual(client.metrics().audits.map(file=>JSON.parse(readFileSync(path.join(runDirectory,file),'utf8')).accepted),[false,true]);
 }
});

test('two invalid model repair identity responses still fail closed without accepting or caching either',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'tsp-repair-identity-stop-'));
 t.after(()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('tsp-repair-identity-stop-'));rmSync(directory,{recursive:true,force:true});});
 const {request}=twoTargetRequest(),bad=response(request,'MODEL_VALUE_MUST_NOT_LEAK');bad.patches[0].decision='withdraw';const model='deepseek-v4.1-flash',runDirectory=path.join(directory,'run'),cacheDirectory=path.join(directory,'cache');let calls=0;
 const client=createSemanticModelClient({config:{modelUrl:'http://model.invalid/v1',model,apiKey:''},snapshotId:'a'.repeat(64),engineIdentity:'exact-engine',runDirectory,cacheDirectory,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(bad)}}]}),{status:200});}});
 await assert.rejects(client.call({phase:'architecture-repair',name:request.name,input:request.input,validate:request.decode}),error=>error.code==='code_analysis_model_invalid'&&error.details.reason==='architecture_field_repair_response_identity'&&error.details.issue_paths.includes('$.patches[0].replacement_text'));
 assert.equal(calls,2);assert.equal(client.cacheRequest({phase:'architecture-repair',input:request.input,validate:request.decode}),null);assert.deepEqual(client.metrics().audits.map(file=>JSON.parse(readFileSync(path.join(runDirectory,file),'utf8')).accepted),[false,false]);
});

test('repair decoding rejects damaged generated narratives with exact repairable paths and preserves supplementary Unicode',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture),request=prepareArchitectureGroundingRepairs(architecture,claims,claims.map(claim=>feedback(claim)),lineage).requests[0],inputHash=semanticDigest(request.input);
 for(const damaged of ['创建\ufffd\ufffd备登录。','孤立高代理项\ud800。','孤立低代理项\udfff。']){
  for(const field of ['replacement_text','unknowns']){
   const raw=response(request,'可见源码定义有限操作。'),at=field==='replacement_text'?'$.patches[0].replacement_text':'$.patches[0].unknowns[0]';
   if(field==='replacement_text')raw.patches[0].replacement_text=damaged;else raw.patches[0].unknowns=[damaged];
   assert.throws(()=>request.decode(raw),error=>{
    assert.equal(error.code,'code_analysis_model_invalid');assert.equal(error.details.reason,'narrative_text_integrity');assert.equal(error.details.repairable,true);assert.deepEqual(error.details.issue_paths,[at]);
    assert.equal(error.details.schema_issues[0].path,at);assert.match(error.details.schema_issues[0].expected,/Unicode/);assert.equal(JSON.stringify(error.details).includes(damaged),false);return true;
   });
  }
 }
 const text='保留中文、emoji 😀 与扩展汉字 𠮷。',raw=response(request,text);raw.patches[0].unknowns=['尚待核实的扩展汉字 𠮷 与 emoji 😀。'];
 const decoded=request.decode(raw);assert.equal(decoded[0].replacement_text,text);assert.deepEqual(decoded[0].unknowns,raw.patches[0].unknowns);assert.equal(semanticDigest(request.input),inputHash);
});

test('repair apply rejects damaged typed patches without rewriting original text, witnesses, paths or audits',()=>{
 const {architecture,lineage}=fixture();architecture.modules[0].summary='原始源码讨论替换字符 \ufffd。';
 const claims=narrative(architecture),body={...witness('const replacementCharacter = "\ufffd";'),path:'src/\ufffd-original.ts'},checks=claims.map(claim=>feedback(claim,'insufficient',[body])),before=semanticDigest({architecture,claims,checks,lineage}),request=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage).requests[0];
 assert.equal(request.input.targets[0].original_text,architecture.modules[0].summary);assert.deepEqual(request.input.source_catalog,[body]);
 const patches=request.decode(response(request,'源码讨论 Unicode 替换字符。'));
 for(const change of [items=>{items[0].replacement_text='损坏\ufffd摘要。';},items=>{items[0].unknowns=['损坏\ud800未知。'];}]){
  const forged=structuredClone(patches);change(forged);assert.throws(()=>applyArchitectureGroundingRepairs(architecture,forged,lineage,[]),error=>error.code==='code_analysis_model_invalid'&&error.details.reason==='architecture_field_repair_text_integrity');
 }
 const result=applyArchitectureGroundingRepairs(architecture,patches,lineage,[]);
 assert.equal(result.architecture.modules[0].summary,'源码讨论 Unicode 替换字符。');assert.ok(result.unknownsAudit.some(item=>item.description.includes(architecture.modules[0].summary)));assert.equal(semanticDigest({architecture,claims,checks,lineage}),before);
});

test('a damaged repair checkpoint is skipped and one live repair replaces only that task while good caches survive',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'tsp-repair-integrity-'));
 t.after(()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('tsp-repair-integrity-'));rmSync(directory,{recursive:true,force:true});});
 const {architecture,lineage}=fixture(),claims=narrative(architecture),request=prepareArchitectureGroundingRepairs(architecture,claims,claims.map(claim=>feedback(claim)),lineage).requests[0],model='deepseek-v4.1-flash',prompts=[];
 const damaged=response(request,'创建\ufffd\ufffd备登录。'),good=response(request,'源码定义创建设备登录。'),task={phase:'architecture-repair',input:request.input,inference_policy:semanticInferencePolicy('architecture-repair')},unaffected={phase:'ownership',input:{task:'unrelated exact owner'},inference_policy:semanticInferencePolicy('ownership')};
 const client=createSemanticModelClient({config:{modelUrl:'http://model.invalid/v1',model,apiKey:''},snapshotId:'a'.repeat(64),engineIdentity:'exact-engine',runDirectory:path.join(directory,'run'),cacheDirectory:path.join(directory,'cache'),fetchImpl:async(_url,options)=>{
  const prompt=JSON.parse(JSON.parse(options.body).messages[1].content);prompts.push(prompt);
  if(prompts.length===2){assert.equal(prompt.correction.reason,'narrative_text_integrity');assert.deepEqual(prompt.correction.fields,['$.patches[0].replacement_text']);assert.equal(readFileSync(cacheFile,'utf8'),oldCacheBytes,'invalid live output must not overwrite the old rejected checkpoint');}
  return new Response(JSON.stringify({model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(prompts.length===1?damaged:good)}}]}),{status:200});
 }});
 client.save(task,damaged,model);client.save(unaffected,{owner:'module:one'},model);
 const cacheFile=path.join(directory,'cache',client.key(task)+'.json'),oldCacheBytes=readFileSync(cacheFile,'utf8');
 assert.equal(client.cacheRequest({phase:'architecture-repair',input:request.input,validate:request.decode}),null);
 assert.equal(client.cache(unaffected,value=>value).value.owner,'module:one');
 const result=await client.call({phase:'architecture-repair',name:request.name,input:request.input,validate:request.decode});
 assert.equal(prompts.length,2);assert.equal(result.value[0].replacement_text,good.patches[0].replacement_text);assert.equal(client.cacheRequest({phase:'architecture-repair',input:request.input,validate:request.decode}).value[0].replacement_text,good.patches[0].replacement_text);
 assert.equal(client.cache(unaffected,value=>value).value.owner,'module:one');assert.equal(client.metrics().calls,2);
});

test('fact-only repair protocol keeps evidence limitations in unknowns and invalidates previous repair tasks without losing source caches',t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'tsp-repair-fact-scope-'));
 t.after(()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('tsp-repair-fact-scope-'));rmSync(directory,{recursive:true,force:true});});
 const {architecture,lineage}=fixture(),claims=narrative(architecture),checks=claims.map(claim=>({...feedback(claim,'insufficient',[witness()]),source_scope:'source_definition'})),request=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage).requests[0];
 assert.equal(request.input.repair_protocol,'architecture-grounded-field-repair-1.4.0');assert.match(request.input.task,/replacement_text只包含.*源码.*事实/);assert.match(request.input.task,/本次取证的.*局限.*unknowns/);
 const facts='条件满足时调用可见的状态更新。',limitations=['本页未提供调用方权限实现。','尚未验证实际运行结果。'],raw=response(request,facts);raw.patches[0].unknowns=limitations;
 const decoded=request.decode(raw),result=applyArchitectureGroundingRepairs(architecture,decoded,lineage,[]);
 assert.equal(result.architecture.modules[0].summary,ARCHITECTURE_SOURCE_DEFINITION_PREFIX+facts);assert.deepEqual(decoded[0].unknowns,limitations);assert.ok(limitations.every(item=>result.unknownsAudit.some(audit=>audit.description===item)));assert.ok(limitations.every(item=>!result.architecture.modules[0].summary.includes(item)));
 const model='deepseek-v4.1-flash',client=createSemanticModelClient({config:{modelUrl:'http://model.invalid/v1',model,apiKey:''},snapshotId:'a'.repeat(64),engineIdentity:'fixed-engine',runDirectory:path.join(directory,'run'),cacheDirectory:path.join(directory,'cache')}),oldInput={...structuredClone(request.input),repair_protocol:'architecture-grounded-field-repair-1.3.0'},oldTask={phase:'architecture-repair',input:oldInput,inference_policy:semanticInferencePolicy('architecture-repair')},sourceTask={phase:'files',input:{source_sha256:'b'.repeat(64)},inference_policy:semanticInferencePolicy('files')};
 client.save(oldTask,raw,model);client.save(sourceTask,{summary:'完整来源事实。'},model);
 assert.notEqual(client.key(oldTask),client.key({phase:'architecture-repair',input:request.input,inference_policy:semanticInferencePolicy('architecture-repair')}));assert.equal(client.cacheRequest({phase:'architecture-repair',input:request.input,validate:request.decode}),null);assert.equal(client.cache(sourceTask,value=>value).value.summary,'完整来源事实。');assert.deepEqual(client.cache(oldTask,request.decode).value[0].unknowns,limitations);
});

test('two blocked spans form one immutable field target with complete reasons and deduplicated complete contradiction witnesses',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture),body=witness(),checks=claims.map(claim=>feedback(claim,'contradicted',[body])),before=semanticDigest({architecture,claims,checks,lineage});
 const plan=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage);assert.equal(plan.requests.length,1);const request=plan.requests[0];
 assert.equal(request.input.targets.length,1);assert.equal(request.input.targets[0].original_text,architecture.modules[0].summary);assert.equal(request.input.targets[0].blocked_claims.length,2);
 assert.match(request.input.task,/提前返回、幂等处理、输入缺失及回退路径/);assert.match(request.input.task,/不能把正常路径/);
 assert.deepEqual(request.input.targets[0].blocked_claims.map(row=>[row.id,row.field,row.text,row.reason]),claims.map(claim=>[claim.id,claim.field,claim.text,checks[0].reason]));
 assert.deepEqual(request.input.source_catalog,[body]);assert.equal(request.input.private_audit.feedback_sha256,semanticDigest(checks));
 const patches=request.decode(response(request)),result=applyArchitectureGroundingRepairs(architecture,patches,lineage,[]),expected=structuredClone(architecture);expected.modules[0].summary=patches[0].replacement_text;
 assert.deepEqual(result.architecture,expected);assert.deepEqual(result.lineage,lineage);assert.equal(result.unknownsAudit.filter(row=>row.claim_ids.length).length,2);
 assert.equal(semanticDigest({architecture,claims,checks,lineage}),before);assert.equal(result.unknownsAudit[1].field,claims[1].field);
});

test('foreign fields, duplicate/missing coverage, stale field hashes, extra evidence and oversized replacements fail closed',()=>{
 const {architecture,lineage}=fixture(),claims=[...narrative(architecture),...narrative(architecture,'flows.0.steps.0.description','flow:view')],plan=prepareArchitectureGroundingRepairs(architecture,claims,claims.map(claim=>feedback(claim)),lineage),request=plan.requests[0];
 for(const mutate of [raw=>{raw.patches[0].field='__proto__.polluted';},raw=>{raw.patches[1]=structuredClone(raw.patches[0]);},raw=>{raw.patches.pop();},raw=>{raw.patches[0].field_sha256='f'.repeat(64);},raw=>{raw.patches[0].evidence=[];},raw=>{raw.patches[0].replacement_text=' ';},raw=>{raw.patches[1].replacement_text='x'.repeat(801);},raw=>{raw.patches[0].unknowns=['a','b','c'];}]){const raw=response(request);mutate(raw);assert.throws(()=>request.decode(raw),{code:'code_analysis_model_invalid'});}
 const patches=request.decode(response(request)),changed=structuredClone(architecture);changed.modules[1].summary+='另一个改动';
 assert.throws(()=>applyArchitectureGroundingRepairs(changed,patches,lineage,[]),error=>error.details.reason==='architecture_field_repair_stale_architecture');
});

test('insufficient complete source bodies remain available for narrow rewriting without approving the original assertion',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture),checks=claims.map(claim=>feedback(claim,'insufficient',[witness()])),plan=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage);
 assert.deepEqual(plan.requests[0].input.source_catalog,[witness()]);assert.equal(JSON.stringify(plan.requests[0].input).includes(witness().text),true);
 assert.match(plan.requests[0].input.task,/不能用来推断替换事实/);assert.match(plan.requests[0].input.task,/限定词继续保留/);assert.match(plan.requests[0].input.task,/decision必须明确/);
 assert.match(plan.requests[0].input.task,/不代表批准原断言/);assert.match(plan.requests[0].input.task,/测试只说明测试定义/);
 assert.deepEqual(plan.requests[0].input.targets[0].blocked_claims.map(block=>block.witness_source_ids),claims.map(()=>['GS-fixed']));
 assert.deepEqual(checks[0].sources,[witness()]);
});

test('source bodies and explicit missing guards remain bound to each field despite a shared deduplicated catalog',()=>{
 const {architecture,lineage}=fixture(),claims=[...narrative(architecture),...narrative(architecture,'flows.0.steps.0.description','flow:view')],other={...witness('function display(){ return null; }'),id:'GS-display'},checks=claims.map((claim,index)=>({...feedback(claim,'insufficient',[index===2?other:witness()]),source_disclosure:'complete_context_retrieved_without_approval',missing_guard_definitions:['required-authority'],source_contexts:[{context_id:'private:'+claim.id,can_assert_supported:false,dependency_closure_complete:false}]})),before=semanticDigest({architecture,claims,checks,lineage});
 const request=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage).requests[0];
 assert.deepEqual(request.input.source_catalog,[witness(),other]);
 assert.deepEqual(request.input.targets.map(target=>target.blocked_claims.map(block=>block.witness_source_ids)),[[['GS-fixed'],['GS-fixed']],[['GS-display']]]);
 for(const target of request.input.targets)for(const block of target.blocked_claims){assert.equal(block.source_disclosure,'complete_context_retrieved_without_approval');assert.deepEqual(block.missing_guard_definitions,['required-authority']);assert.equal(block.source_contexts[0].can_assert_supported,false);assert.equal(block.source_contexts[0].dependency_closure_complete,false);}
 assert.match(request.input.task,/不能借用共享目录中其他字段的来源/);assert.match(request.input.task,/不能因存在完整正文就推断未提供的守卫/);
 assert.ok(request.input.targets.every(target=>target.declaredScope===false));
 assert.equal(semanticDigest({architecture,claims,checks,lineage}),before);
 const patches=request.decode(response(request,'源码定义了一个有限的静态分支。'));
 assert.ok(patches.every(patch=>patch.assertion_scope===undefined));
 assert.deepEqual(applyArchitectureGroundingRepairs(architecture,patches,lineage,[]).declaration_fields,[]);
});

test('host declares source-definition scope only when every blocked claim provides scoped source bodies',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture),checks=claims.map(claim=>({...feedback(claim,'insufficient',[witness()]),source_scope:'source_definition'})),before=semanticDigest({architecture,claims,checks,lineage}),request=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage).requests[0],target=request.input.targets[0];
 assert.equal(target.declaredScope,true);assert.equal(target.max_length,1600-ARCHITECTURE_SOURCE_DEFINITION_PREFIX.length);assert.ok(target.blocked_claims.every(block=>block.source_scope==='source_definition'));
 const patches=request.decode(response(request,'该来源定义了返回 false 的操作。'));
 assert.equal(patches[0].replacement_text,ARCHITECTURE_SOURCE_DEFINITION_PREFIX+'该来源定义了返回 false 的操作。');assert.equal(patches[0].assertion_scope,'source_definition');
 const result=applyArchitectureGroundingRepairs(architecture,patches,lineage,[]);
 assert.deepEqual(result.declaration_fields,[{field:'modules.0.summary',node_id:'module:one',assertion_scope:'source_definition'}]);assert.deepEqual(result.withdrawn_fields,[]);assert.equal(result.architecture.modules[0].summary,patches[0].replacement_text);
 assert.equal(semanticDigest({architecture,claims,checks,lineage}),before);
 for(const change of [rows=>{delete rows[0].source_scope;},rows=>{rows[0].sources=[];},rows=>{for(const row of rows)row.sources=[];}]){const changed=structuredClone(checks);change(changed);const mixed=prepareArchitectureGroundingRepairs(architecture,claims,changed,lineage).requests[0];assert.equal(mixed.input.targets[0].declaredScope,false);assert.equal(mixed.input.targets[0].max_length,1600);assert.equal(mixed.decode(response(mixed,'保留有据的窄范围描述。'))[0].assertion_scope,undefined);}
 const withdrawal=applyArchitectureGroundingRepairs(architecture,request.decode(response(request,'','withdraw')),lineage,[]);assert.deepEqual(withdrawal.declaration_fields,[]);assert.equal(withdrawal.withdrawn_fields.length,1);
});

test('mixed document and implementation sources keep source notes outside the unqualified replacement and preserve their audit',()=>{
 const {architecture,lineage}=fixture();architecture.modules[0].summary='资料声明操作自动完成。可见实现按条件返回结果。';
 const claims=narrative(architecture),document={...witness('操作设计为自动完成。'),id:'GS-document',path:'README.md',source_kind:'document'},code=witness('function operate(ready){ if (!ready) return false; return true; }'),checks=[{...feedback(claims[0],'insufficient',[document]),source_scope:'source_definition'},feedback(claims[1],'insufficient',[code])],before=semanticDigest({architecture,claims,checks,lineage});
 const request=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage).requests[0],target=request.input.targets[0];
 assert.equal(request.input.repair_protocol,'architecture-grounded-field-repair-1.4.0');assert.equal(target.declaredScope,false);assert.equal(target.max_length,1600);
 assert.deepEqual(target.blocked_claims.map(block=>block.witness_source_ids),[['GS-document'],['GS-fixed']]);assert.deepEqual(request.input.source_catalog,[document,code]);
 const facts='可见实现按条件返回结果。',note='来源说明：资料声明操作自动完成，该设计是否已实现尚待核实。',raw=response(request,facts);raw.patches[0].unknowns=[note];
 const patches=request.decode(raw),result=applyArchitectureGroundingRepairs(architecture,patches,lineage,[]);
 assert.equal(patches[0].assertion_scope,undefined);assert.equal(result.architecture.modules[0].summary,facts);assert.equal(result.architecture.modules[1].summary,architecture.modules[1].summary);
 assert.deepEqual(result.declaration_fields,[]);assert.deepEqual(result.withdrawn_fields,[]);assert.deepEqual(result.unknownsAudit.filter(item=>!item.claim_ids.length).map(item=>item.description),[note]);
 assert.ok(result.unknownsAudit.some(item=>item.claim_ids.includes(claims[0].id)&&item.description.includes(claims[0].text)));assert.equal(semanticDigest({architecture,claims,checks,lineage}),before);
});

test('host-only source declaration reserves the prefix budget and rejects model metadata or a duplicate prefix',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture),checks=claims.map(claim=>({...feedback(claim,'insufficient',[witness()]),source_scope:'source_definition'})),request=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage).requests[0],limit=request.input.targets[0].max_length;
 const exact=request.decode(response(request,'x'.repeat(limit)));assert.equal(exact[0].replacement_text.length,1600);assert.equal(applyArchitectureGroundingRepairs(architecture,exact,lineage,[]).architecture.modules[0].summary.length,1600);
 assert.throws(()=>request.decode(response(request,'x'.repeat(limit+1))),{code:'code_analysis_model_invalid'});
 assert.throws(()=>request.decode(response(request,ARCHITECTURE_SOURCE_DEFINITION_PREFIX+'来源声明。')),{code:'code_analysis_model_invalid'});
 const forged=response(request,'来源声明。');forged.patches[0].assertion_scope='source_definition';assert.throws(()=>request.decode(forged),{code:'code_analysis_model_invalid'});
 const changed=structuredClone(exact);changed[0].replacement_text='缺失宿主前缀的断言。';assert.throws(()=>applyArchitectureGroundingRepairs(architecture,changed,lineage,[]),{code:'code_analysis_model_invalid'});
});

test('withdrawal is an explicit typed decision, preserves the complete old field in audit, and cannot be forged by navigation wording',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture),checks=claims.map(claim=>feedback(claim)),plan=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage),request=plan.requests[0];
 assert.equal(request.input.repair_protocol,'architecture-grounded-field-repair-1.4.0');
 const withdrawn=applyArchitectureGroundingRepairs(architecture,request.decode(response(request,'','withdraw')),lineage,[]);
 assert.deepEqual(withdrawn.withdrawn_fields,[{field:'modules.0.summary',node_id:'module:one'}]);
 assert.equal(withdrawn.architecture.modules[0].summary,'本节点提供相关源码详情的阅读入口。');
 assert.ok(withdrawn.unknownsAudit.some(item=>item.description.includes(architecture.modules[0].summary)));
 assert.ok(checks.every(check=>withdrawn.unknownsAudit.some(item=>item.description.includes(check.reason))));
 assert.deepEqual(withdrawn.architecture.modules[1],architecture.modules[1]);
 const merelyWorded=applyArchitectureGroundingRepairs(architecture,request.decode(response(request,'本节点提供相关源码详情的阅读入口。','replace')),lineage,[]);
 assert.deepEqual(merelyWorded.withdrawn_fields,[],'only the exact host-validated decision permits later claim exclusion');
 for(const raw of [response(request,'仍然肯定原事实。','withdraw'),response(request,' ','withdraw'),response(request,'','replace')])assert.throws(()=>request.decode(raw),{code:'code_analysis_model_invalid'});
 const missing=response(request);delete missing.patches[0].decision;assert.throws(()=>request.decode(missing),{code:'code_analysis_model_invalid'});
 const invalid=response(request);invalid.patches[0].decision='approved';assert.throws(()=>request.decode(invalid),{code:'code_analysis_model_invalid'});
 const forged=request.decode(response(request));delete forged[0].decision;assert.throws(()=>applyArchitectureGroundingRepairs(architecture,forged,lineage,[]),{code:'code_analysis_model_invalid'});
});

test('rule-only repair withdraws the exact parent/scope across all applications and preserves identical predicates from another scope',()=>{
 const {architecture,lineage}=fixture(),claim={id:'claim:rule',node_id:'module:one',field:'rule_application:OR-same:OS-first',text:lineage[0].description,kind:'rule_application',evidence:structuredClone(evidence),scope_context:{parent_rule_id:'OR-same',origin_scope_id:'OS-first',application_nodes:['module:one','capability:view']}},check=feedback(claim),before=semanticDigest({architecture,lineage});
 const plan=prepareArchitectureGroundingRepairs(architecture,[claim],[check],lineage);assert.deepEqual(plan.requests,[]);assert.equal(plan.withdrawn_rule_claims.length,1);
 const result=applyArchitectureGroundingRepairs(architecture,[],lineage,plan.withdrawn_rule_claims);
 assert.equal(result.architecture.modules[0].business_rules.length,1);assert.equal(result.architecture.capabilities[0].business_rules.length,0);assert.deepEqual(result.architecture.modules[0].business_rules[0],architecture.modules[0].business_rules[1]);
 assert.equal(result.lineage.length,1);assert.equal(result.lineage[0].origin_scope_id,'OS-second');assert.equal(result.lineage[0].rule_index,0);assert.equal(result.unknownsAudit.length,2);assert.ok(result.unknownsAudit.every(row=>row.description.includes(claim.text)&&row.description.includes(check.reason)));
 assert.deepEqual(result.architecture.unknowns,architecture.unknowns);assert.equal(semanticDigest({architecture,lineage}),before);
 const forged=structuredClone(plan.withdrawn_rule_claims);forged[0].applications[0].rule_index=1;
 assert.throws(()=>applyArchitectureGroundingRepairs(architecture,[],lineage,forged),{code:'code_analysis_model_invalid'});
});

test('host rejects field/span/context forgery, source-content identity changes and conflicting GS records',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture);
 for(const change of [items=>{items[0].scope_context.field='description';},items=>{items[0].scope_context.field_text='伪造原文';},items=>{items[0].scope_context.field_span=[0,1];},items=>{items[0].node_id='module:two';}]){const changed=structuredClone(claims);change(changed);assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,changed,changed.map(claim=>feedback(claim)),lineage),{code:'code_analysis_model_invalid'});}
 for(const status of ['contradicted','insufficient']){
 const bad=witness();bad.text+='changed';assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,claims,claims.map(claim=>feedback(claim,status,[bad])),lineage),error=>error.details.reason==='architecture_field_repair_source_identity');
 const collision=[feedback(claims[0],status,[witness('function first(){}')]),feedback(claims[1],status,[witness('function second(){}')])];assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,claims,collision,lineage),error=>error.details.reason==='architecture_field_repair_source_collision');
 }
 const checks=claims.map(claim=>feedback(claim));checks[0].text_sha256='f'.repeat(64);assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage),{code:'code_analysis_model_invalid'});
});

test('whole fields pack at most eight per request with real byte limits and an indivisible oversized witness is never cropped',()=>{
 const {architecture,lineage}=fixture();architecture.modules[0].state_owners=Array.from({length:17},(_,index)=>`状态${index}。`);
 const claims=architecture.modules[0].state_owners.map((text,index)=>({id:'owner:'+index,node_id:'module:one',field:`modules.0.state_owners.${index}:0-${text.length}`,text,kind:'narrative',evidence:structuredClone(evidence)}));
 const plan=prepareArchitectureGroundingRepairs(architecture,claims,claims.map(claim=>feedback(claim)),lineage);assert.deepEqual(plan.requests.map(request=>request.input.targets.length),[8,8,1]);assert.equal(plan.statistics.writable_fields,17);assert.ok(plan.requests.every(request=>request.byteLength<=120000));
 const large=witness('x'.repeat(180000));assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,[claims[0]],[feedback(claims[0],'contradicted',[large])],lineage),error=>error.details.reason==='architecture_field_repair_request_budget');assert.equal(large.text.length,180000);
});

function oversizedDescription(text='已知职责。\n未提供的保证。  保留原文。\t',blocked='未提供的保证。',sourceScope=false){
 const {architecture,lineage}=fixture();architecture.description=text;const start=text.indexOf(blocked),end=start+blocked.length,claim={id:'claim:oversized',node_id:'system',field:`description:${start}-${end}`,text:blocked,kind:'narrative',evidence:structuredClone(evidence),scope_context:{field:'description',field_text:text,field_span:[start,end]}},check={...feedback(claim,'insufficient',[witness('x'.repeat(180000))]),...(sourceScope?{source_scope:'source_definition'}:{})};
 return{architecture,lineage,claim,check};
}

test('only oversized insufficient fields retract exact original spans and retain all other characters and complete private sources',()=>{
 const {architecture,lineage,claim,check}=oversizedDescription(),before=semanticDigest({architecture,lineage,claim,check}),plan=prepareArchitectureGroundingRepairs(architecture,[claim],[check],lineage);
 assert.deepEqual(plan.requests,[]);assert.equal(plan.span_withdrawals.length,1);assert.equal(plan.statistics.host_span_withdrawals,1);
 const withdrawal=plan.span_withdrawals[0];assert.equal(withdrawal.actor,'host_budget_retraction');assert.equal(withdrawal.field_sha256,semanticDigest(architecture.description));assert.ok(withdrawal.request_bytes>179000);assert.deepEqual(withdrawal.spans[0].feedback,check);assert.equal(withdrawal.spans[0].feedback.sources[0].text.length,180000);assert.equal(withdrawal.private_audit.feedback_sha256,semanticDigest([check]));
 const result=applyArchitectureGroundingRepairs(architecture,[],lineage,[],plan.span_withdrawals);
 assert.equal(result.architecture.description,'已知职责。\n  保留原文。\t');assert.deepEqual(result.architecture.modules,architecture.modules);assert.deepEqual(result.withdrawn_fields,[]);assert.deepEqual(result.declaration_fields,[]);assert.deepEqual(result.host_span_withdrawals,plan.span_withdrawals);
 assert.equal(result.unknownsAudit[0].actor,'host_budget_retraction');assert.match(result.unknownsAudit[0].description,/宿主因完整来源超过修正请求预算/);assert.match(result.unknownsAudit[0].description,/保留内容仍须再次核验/);assert.ok(result.unknownsAudit[0].description.includes(claim.text));assert.ok(result.unknownsAudit[0].description.includes(check.reason));assert.equal(semanticDigest({architecture,lineage,claim,check}),before);
 const small={...check,sources:[witness()]},ordinary=prepareArchitectureGroundingRepairs(architecture,[claim],[small],lineage);assert.equal(ordinary.requests.length,1);assert.deepEqual(ordinary.span_withdrawals,[]);
 const contradiction={...check,status:'contradicted'};assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,[claim],[contradiction],lineage),error=>error.details.reason==='architecture_field_repair_request_budget');
});

test('host span retraction rejects malformed, overlapping, foreign, stale and contradictory records',()=>{
 const {architecture,lineage,claim,check}=oversizedDescription(),plan=prepareArchitectureGroundingRepairs(architecture,[claim],[check],lineage);
 for(const change of [rows=>{rows[0].spans[0].start=-1;},rows=>{rows[0].spans[0].end=architecture.description.length+1;},rows=>{rows[0].spans[0].start='1';},rows=>{rows[0].spans.push(structuredClone(rows[0].spans[0]));},rows=>{rows[0].spans[0].text_sha256='f'.repeat(64);},rows=>{rows[0].spans[0].feedback.field='description:0-1';},rows=>{rows[0].spans[0].feedback.status='contradicted';},rows=>{rows[0].node_id='module:one';},rows=>{rows[0].field_sha256='f'.repeat(64);},rows=>{rows[0].actor='agent';},rows=>{rows[0].request_bytes=179000;}]){const changed=structuredClone(plan.span_withdrawals);change(changed);assert.throws(()=>applyArchitectureGroundingRepairs(architecture,[],lineage,[],changed),{code:'code_analysis_model_invalid'});}
 const changed=structuredClone(architecture);changed.modules[1].summary+='新版本';assert.throws(()=>applyArchitectureGroundingRepairs(changed,[],lineage,[],plan.span_withdrawals),error=>error.details.reason==='architecture_field_repair_stale_architecture');
 const overlap={...structuredClone(claim),id:'claim:overlap',field:`description:0-${architecture.description.length}`,text:architecture.description,scope_context:{field:'description',field_text:architecture.description,field_span:[0,architecture.description.length]}};
 assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,[claim,overlap],[check,feedback(overlap,'insufficient',[witness('x'.repeat(180000))])],lineage),error=>error.details.reason==='architecture_field_repair_span_binding');
});

test('host span retraction uses the neutral placeholder only when no original content remains',()=>{
 const {architecture,lineage,claim,check}=oversizedDescription('未提供的保证。','未提供的保证。'),plan=prepareArchitectureGroundingRepairs(architecture,[claim],[check],lineage),result=applyArchitectureGroundingRepairs(architecture,[],lineage,[],plan.span_withdrawals);
 assert.equal(result.architecture.description,'本节点提供相关源码详情的阅读入口。');assert.deepEqual(result.withdrawn_fields,[{field:'description',node_id:'system'}]);assert.deepEqual(result.declaration_fields,[]);assert.ok(result.unknownsAudit[0].description.includes(architecture.description));
});

test('host span retraction restores the source-definition qualifier without rewriting surviving source text',()=>{
 const blocked=ARCHITECTURE_SOURCE_DEFINITION_PREFIX+'未提供的保证。',survivor='  文档定义了可见的流程。\n',text=blocked+survivor,{architecture,lineage,claim,check}=oversizedDescription(text,blocked,true),plan=prepareArchitectureGroundingRepairs(architecture,[claim],[check],lineage),result=applyArchitectureGroundingRepairs(architecture,[],lineage,[],plan.span_withdrawals);
 assert.equal(plan.span_withdrawals[0].assertion_scope,'source_definition');assert.equal(result.architecture.description,ARCHITECTURE_SOURCE_DEFINITION_PREFIX+survivor);assert.deepEqual(result.declaration_fields,[{field:'description',node_id:'system',assertion_scope:'source_definition'}]);assert.deepEqual(result.withdrawn_fields,[]);assert.equal(result.unknownsAudit[0].actor,'host_budget_retraction');
});

test('bounded repair waves bind the correct private feedback artifact while rejecting arbitrary audit paths',()=>{
 const {architecture,lineage}=fixture(),claims=narrative(architecture),checks=claims.map(claim=>feedback(claim));
 const initial=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage),next=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage,{feedbackRef:'semantic-global-grounding-2.json#/feedback'});
 assert.equal(initial.requests[0].input.private_audit.ref,'semantic-global-grounding-0.json#/feedback');
 assert.equal(next.requests[0].input.private_audit.ref,'semantic-global-grounding-2.json#/feedback');
 assert.equal(next.requests[0].input.private_audit.feedback_sha256,semanticDigest(checks));assert.equal(next.previous_sha256,initial.previous_sha256);
 for(const feedbackRef of ['../../private.json#/feedback','semantic-global-grounding-4.json#/feedback','semantic-global-grounding-0.json#/dependencies'])assert.throws(()=>prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage,{feedbackRef}),error=>error.details.reason==='architecture_field_repair_audit_reference');
});

test('repair witnesses become private field-bound retrieval anchors without changing the model wire or publication evidence',()=>{
 const {architecture,lineage}=fixture(),claims=[...narrative(architecture),...narrative(architecture,'flows.0.steps.0.description','flow:view')];
 const moduleSource={...witness('complete merge source'),id:'GS-merge',path:'scripts/merge.mjs',line_end:35},stepSource={...witness('complete workflow source'),id:'GS-workflow',path:'workflow.yml',line_end:85};
 const checks=claims.map(claim=>feedback(claim,'insufficient',claim.node_id==='flow:view'?[stepSource]:[moduleSource,moduleSource]));
 const request=prepareArchitectureGroundingRepairs(architecture,claims,checks,lineage).requests[0],wire=JSON.stringify(request.input),raw=response(request,'保留有依据的源码说明。');
 const patches=request.decode(raw),result=applyArchitectureGroundingRepairs(architecture,patches,lineage,[]);
 assert.deepEqual(patches.map(patch=>patch.retrieval_anchors),[
  [{path:'scripts/merge.mjs',line_start:1,line_end:35}],
  [{path:'workflow.yml',line_start:1,line_end:85}],
 ]);
 assert.deepEqual(result.field_retrieval_anchors,patches.map(patch=>({field:patch.field,node_id:patch.node_id,text_sha256:semanticDigest(patch.replacement_text),anchors:patch.retrieval_anchors})));
 assert.deepEqual(result.architecture.modules[0].evidence,architecture.modules[0].evidence);
 assert.deepEqual(result.architecture.flows[0].steps[0].evidence,architecture.flows[0].steps[0].evidence);
 assert.equal(JSON.stringify(request.input),wire,'host-only anchor propagation must not alter prompt or cache identity');
 const injected=structuredClone(raw);injected.patches[0].retrieval_anchors=[{path:'foreign.ts',line_start:1,line_end:3}];
 assert.throws(()=>request.decode(injected),{code:'code_analysis_model_invalid'});
 assert.equal('field_retrieval_anchors' in result.architecture,false,'retrieval metadata is never published as architecture support');
});

test('a subsequent replacement updates only its own retrieval anchors and withdrawal removes them',()=>{
 const {architecture,lineage}=fixture(),claims=[...narrative(architecture),...narrative(architecture,'flows.0.steps.0.description','flow:view')];
 const firstSource={...witness('first'),id:'GS-first',path:'first.ts'},otherSource={...witness('other'),id:'GS-other',path:'other.ts'};
 const firstRequest=prepareArchitectureGroundingRepairs(architecture,claims,claims.map(claim=>feedback(claim,'insufficient',claim.node_id==='flow:view'?[otherSource]:[firstSource])),lineage).requests[0];
 const first=applyArchitectureGroundingRepairs(architecture,firstRequest.decode(response(firstRequest,'有据的原始修正。')),lineage,[]);
 const nextClaims=narrative(first.architecture),nextSource={...witness('next'),id:'GS-next',path:'next.ts'};
 const nextRequest=prepareArchitectureGroundingRepairs(first.architecture,nextClaims,nextClaims.map(claim=>feedback(claim,'insufficient',[nextSource])),first.lineage).requests[0];
 const next=applyArchitectureGroundingRepairs(first.architecture,nextRequest.decode(response(nextRequest,'有据的下一次修正。')),first.lineage,[],[],first.field_retrieval_anchors);
 assert.deepEqual(next.field_retrieval_anchors.find(item=>item.field==='modules.0.summary').anchors,[{path:'next.ts',line_start:1,line_end:3}]);
 assert.deepEqual(next.field_retrieval_anchors.find(item=>item.field==='flows.0.steps.0.description'),first.field_retrieval_anchors.find(item=>item.field==='flows.0.steps.0.description'));
 const finalClaims=narrative(next.architecture),withdrawRequest=prepareArchitectureGroundingRepairs(next.architecture,finalClaims,finalClaims.map(claim=>feedback(claim)),next.lineage).requests[0];
 const withdrawn=applyArchitectureGroundingRepairs(next.architecture,withdrawRequest.decode(response(withdrawRequest,'','withdraw')),next.lineage,[],[],next.field_retrieval_anchors);
 assert.deepEqual(withdrawn.field_retrieval_anchors,first.field_retrieval_anchors.filter(item=>item.field!=='modules.0.summary'));
 for(const change of [rows=>{rows[0].node_id='foreign';},rows=>{rows[0].text_sha256='f'.repeat(64);},rows=>{rows.push(structuredClone(rows[0]));}]){
  const bad=structuredClone(next.field_retrieval_anchors);change(bad);
  assert.throws(()=>applyArchitectureGroundingRepairs(next.architecture,[],next.lineage,[],[],bad),{code:'code_analysis_model_invalid'});
 }
});
