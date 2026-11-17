import { test } from 'node:test';
import assert from 'node:assert/strict';
import { architectureGroundingClaims, mergeArchitectureSourceRecovery } from '../dist/code-analysis-semantic-architecture.js';
import { ARCHITECTURE_SOURCE_DEFINITION_PREFIX as prefix, prepareArchitectureGroundingRepairs, applyArchitectureGroundingRepairs } from '../dist/code-analysis-semantic-repair.js';
import { prepareArchitectureClaimSourceSelection } from '../dist/code-analysis-semantic-selector.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';

const evidence = [{ path: 'src/operation.ts', line_start: 1, line_end: 4 }];
function report(rows) {
  const checks = rows.map(([id, status]) => ({ id, status, reason: id, evidence: [{ path: id, line_start: 1, line_end: 2 }] }));
  return { checks, blocking: checks.filter(check => check.status !== 'supported'), feedback: checks.filter(check => check.status !== 'supported').map(check => ({ ...check, sources: [{ id: check.id + ':source', text: 'original witness' }] })), dependencies: checks.map(check => ({ claim_id: check.id, context_id: check.id + ':context', guard_definition_ids: [check.id + ':guard'] })), statistics: { claims: checks.length } };
}

test('uncached recovery replaces only changed insufficient claims and preserves contradictions and original witnesses', () => {
  const initial = report([['known-counterexample', 'contradicted'], ['lookup-miss', 'insufficient'], ['already-supported', 'supported']]);
  const before = structuredClone(initial), recovered = report([['lookup-miss', 'supported']]);
  const merged = mergeArchitectureSourceRecovery(initial, recovered, new Set(['lookup-miss']));
  assert.deepEqual(merged.checks[0], initial.checks[0]);
  assert.deepEqual(merged.blocking, [initial.blocking[0]]);
  assert.deepEqual(merged.feedback, [initial.feedback[0]]);
  assert.deepEqual(merged.dependencies.filter(row => row.claim_id === 'known-counterexample'), [initial.dependencies[0]]);
  assert.equal(merged.checks.find(row => row.id === 'lookup-miss').status, 'supported');
  assert.deepEqual(initial, before);
  // A second verdict that tries to erase the contradiction is rejected even
  // without a cache, as are extra rows hidden in its witness/dependency lists.
  assert.throws(() => mergeArchitectureSourceRecovery(initial, report([['known-counterexample', 'supported']]), new Set(['known-counterexample'])), error => error.details.reason === 'source_recovery_merge_identity');
  for (const property of ['checks', 'feedback', 'dependencies']) {
    const foreign = structuredClone(recovered);
    foreign[property].push(property === 'dependencies' ? { claim_id: 'known-counterexample' } : { id: 'known-counterexample' });
    assert.throws(() => mergeArchitectureSourceRecovery(initial, foreign, new Set(['lookup-miss'])), error => error.details.reason === 'source_recovery_merge_identity');
  }
});
function fixture() {
  return {
    description: '全局职责。', languages: [], frameworks: [],
    modules: [{ id: 'module:one', name: '状态模块', summary: '模块职责。', state_owners: ['状态归属。'], user_purposes: ['读取状态。'], business_rules: [], evidence }],
    capabilities: [{ id: 'capability:read', name: '读取状态', summary: '读取能力。', module_ids: ['module:one'], business_rules: [], evidence }],
    flows: [{ id: 'flow:read', name: '读取流程', summary: '流程摘要。', steps: [{ capability_id: 'capability:read', description: '读取后展示。', evidence }], business_rules: [], evidence }],
    relations: [{ source: 'module:one', target: 'capability:read', type: 'depends_on', description: '模块提供读取能力。', evidence }],
    unknowns: ['本页未提供运行结果。'],
  };
}
function fieldClaims(architecture, qualified = new Set()) {
  return architectureGroundingClaims(architecture, [], new Set(), qualified).filter(claim => claim.scope_context.field === 'modules.0.summary');
}

test('only an exact leading host qualifier in a host-qualified field is excluded while full original spans stay bound', () => {
  const architecture = fixture(), text = prefix + '条件满足时调用 😀 操作。第二段仍有原文空格。\n  第三段。';
  architecture.modules[0].summary = text;
  const before = semanticDigest(architecture), claims = fieldClaims(architecture, new Set(['modules.0.summary']));
  assert.equal(claims.length, 3); assert.equal(claims[0].scope_context.field_span[0], prefix.length);
  for (const claim of claims) {
    const [start, end] = claim.scope_context.field_span;
    assert.equal(claim.scope_context.field_text, text);
    assert.equal(claim.text, text.slice(start, end));
    assert.equal(claim.field, `modules.0.summary:${start}-${end}`);
    assert.equal(claim.assertion_scope, 'source_definition');
    assert.equal(claim.id, 'GC-' + semanticDigest({ node_id: claim.node_id, field: claim.field, text: claim.text }));
    assert.deepEqual(claim.evidence, evidence);
  }
  assert.equal(claims.map(claim => claim.text).join(''), text.slice(prefix.length).replace('\n', ''));
  assert.equal(semanticDigest(architecture), before);
});

test('model-written qualifiers, similar text and arbitrary evidence-limit prose are never exempted as host metadata', () => {
  for (const [text, qualified] of [
    [prefix + '原文事实。', new Set()],
    [' ' + prefix + '原文事实。', new Set(['modules.0.summary'])],
    ['【来源定义，尚未实际执行】原文事实。', new Set(['modules.0.summary'])],
    ['原文事实。', new Set(['modules.0.summary'])],
  ]) {
    const architecture = fixture(); architecture.modules[0].summary = text;
    const claims = fieldClaims(architecture, qualified);
    assert.equal(claims[0].scope_context.field_span[0], 0);
    assert.equal(claims.map(claim => claim.text).join(''), text);
    assert.equal(claims[0].assertion_scope, qualified.size ? 'source_definition' : undefined);
  }
  const architecture = fixture(), factualText = '本页未提供权限定义。未证明实际运行。未展开其他源码。';
  architecture.modules[0].summary = prefix + factualText;
  const claims = fieldClaims(architecture, new Set(['modules.0.summary']));
  assert.equal(claims.length, 3);
  assert.equal(claims.map(claim => claim.text).join(''), factualText, 'epistemic wording in a factual field remains a review obligation');
  assert.equal(architectureGroundingClaims(architecture, []).some(claim => claim.text === architecture.unknowns[0]), false);
});

test('all host-qualified scalar fields retain their own original offsets and only one leading qualifier is metadata', () => {
  const architecture = fixture(), fields = new Map([
    ['description', [architecture, 'description']],
    ['modules.0.summary', [architecture.modules[0], 'summary']],
    ['modules.0.state_owners.0', [architecture.modules[0].state_owners, 0]],
    ['modules.0.user_purposes.0', [architecture.modules[0].user_purposes, 0]],
    ['capabilities.0.summary', [architecture.capabilities[0], 'summary']],
    ['flows.0.summary', [architecture.flows[0], 'summary']],
    ['flows.0.steps.0.description', [architecture.flows[0].steps[0], 'description']],
    ['relations.0.description', [architecture.relations[0], 'description']],
  ]);
  for (const [object, key] of fields.values()) object[key] = prefix + '可见源码定义的事实。';
  const claims = architectureGroundingClaims(architecture, [], new Set(), new Set(fields.keys()));
  assert.equal(claims.length, fields.size);
  for (const claim of claims) {
    assert.equal(claim.text, '可见源码定义的事实。');
    assert.deepEqual(claim.scope_context.field_span, [prefix.length, prefix.length + claim.text.length]);
  }
  architecture.modules[0].summary = prefix + prefix + '第二个前缀仍须核验。';
  assert.equal(fieldClaims(architecture, new Set(['modules.0.summary']))[0].text, prefix + '第二个前缀仍须核验。');
});

test('default claim identities and retrieval inputs remain byte-for-byte unchanged without repair anchors', () => {
  const architecture=fixture(),claims=architectureGroundingClaims(architecture,[]);
  assert.equal(semanticDigest(claims),'cd2f884528846ebd60a14de723be092a61bec79e86aca3e3cee35608ea959232');
  assert.equal(JSON.stringify(architectureGroundingClaims(architecture,[],new Set(),new Set(),[])),JSON.stringify(claims));
});

test('complete field repair witnesses remain reachable in the next real source catalog without leaking to sibling claims or publication support', () => {
  const architecture=fixture(),originalRanges=[
    {path:'scripts/merge.mjs',line_start:4,line_end:21},
    {path:'.github/workflows/release.yml',line_start:8,line_end:32},
    {path:'apps/web/tests/serving.test.mjs',line_start:67,line_end:77},
  ];
  architecture.modules[0].evidence=structuredClone(originalRanges);
  const fullRanges=originalRanges.map((range,index)=>({...range,line_start:1,line_end:[35,85,94][index]}));
  const sources=fullRanges.map((range,index)=>{const text=Array.from({length:range.line_end},(_,line)=>`source ${index} line ${line+1}`).join('\n');return{id:'GS-full-'+index,...range,file_sha256:semanticDigest(text),text_sha256:semanticDigest(text),text};});
  const original=structuredClone(architecture),beforeClaims=architectureGroundingClaims(architecture,[]),claim=beforeClaims.find(item=>item.scope_context.field==='modules.0.summary');
  const feedback={id:claim.id,node_id:claim.node_id,field:claim.field,text_sha256:semanticDigest(claim.text),status:'insufficient',reason:'需要完整的合并、CI与服务测试见证。',evidence:originalRanges,context_ids:['context:repair'],sources};
  const request=prepareArchitectureGroundingRepairs(architecture,[claim],[feedback],[]).requests[0];
  const patches=request.decode({patches:request.input.targets.map(target=>({field:target.field,field_sha256:target.field_sha256,decision:'replace',replacement_text:'合并脚本检查产物。CI与服务测试定义保留各自来源。',unknowns:[]}))});
  const applied=applyArchitectureGroundingRepairs(architecture,patches,[],[]);
  const plain=architectureGroundingClaims(applied.architecture,[]),next=architectureGroundingClaims(applied.architecture,[],new Set(),new Set(),applied.field_retrieval_anchors);
  const unaffected=items=>items.filter(item=>item.scope_context.field!=='modules.0.summary');
  assert.deepEqual(unaffected(next),unaffected(plain),'exact field anchors cannot expand its state-owner, purpose, rule or sibling source catalogs');
  const files=[{path:'src/operation.ts',line_count:4,sha256:'a'.repeat(64),byte_count:4},...sources.map(source=>({path:source.path,line_count:source.line_end,sha256:source.file_sha256,byte_count:Buffer.byteLength(source.text)}))];
  const planning=prepareArchitectureClaimSourceSelection({snapshot:{snapshot_id:'b'.repeat(64),files},native:{nodes:[],edges:[],evidence:[]},claims:next.filter(item=>item.scope_context.field==='modules.0.summary')});
  for(const context of planning.contexts)for(const range of fullRanges)assert.ok(context.candidates.some(candidate=>candidate.definition_kind==='source_reference'&&candidate.path===range.path&&candidate.line_start===1&&candidate.line_end===range.line_end),`lost full repair witness ${range.path}`);
  assert.deepEqual(applied.architecture.modules[0].evidence,originalRanges,'repair anchors never become publication evidence without the source verifier');
  assert.deepEqual(architecture,original,'input architecture remains immutable');
  for(const change of [rows=>{rows[0].node_id='module:foreign';},rows=>{rows[0].text_sha256='f'.repeat(64);},rows=>{rows.push(structuredClone(rows[0]));}]){
    const invalid=structuredClone(applied.field_retrieval_anchors);change(invalid);
    assert.throws(()=>architectureGroundingClaims(applied.architecture,[],new Set(),new Set(),invalid),{code:'code_analysis_model_invalid'});
  }
});

function spanRetractionFixture(qualified=false,full=false) {
  const architecture=fixture(),blocked='未核实的保证。';
  architecture.description=(qualified?prefix:'')+(full?blocked:'保留的前置事实。'+blocked+'保留的后续事实。');
  const claim=architectureGroundingClaims(architecture,[],new Set(),qualified?new Set(['description']):new Set()).find(item=>item.text===blocked);
  const text='x'.repeat(180000),feedback={id:claim.id,node_id:claim.node_id,field:claim.field,text_sha256:semanticDigest(claim.text),status:'insufficient',reason:'此跨度缺少足够依据且完整见证超过修正请求预算。',evidence,context_ids:['context:oversized'],...(qualified?{source_scope:'source_definition'}:{}),sources:[{id:'GS-oversized',path:'src/oversized.ts',line_start:1,line_end:1,file_sha256:'a'.repeat(64),text_sha256:semanticDigest(text),text}]};
  const plan=prepareArchitectureGroundingRepairs(architecture,[claim],[feedback],[]);
  assert.equal(plan.requests.length,0);assert.equal(plan.span_withdrawals.length,1);
  const anchors=[{field:'description',node_id:'system',text_sha256:semanticDigest(architecture.description),anchors:[{path:'scripts/complete.mjs',line_start:1,line_end:35}]}];
  return {architecture,plan,anchors};
}

test('partial host span retraction rebinds existing full-witness anchors to retained text for the next real source catalog',()=>{
  for(const qualified of [false,true]){
    const {architecture,plan,anchors}=spanRetractionFixture(qualified),before=semanticDigest({architecture,anchors});
    const result=applyArchitectureGroundingRepairs(architecture,[],[],[],plan.span_withdrawals,anchors);
    const retained=(qualified?prefix:'')+'保留的前置事实。保留的后续事实。';
    assert.equal(result.architecture.description,retained);assert.deepEqual(result.withdrawn_fields,[]);
    assert.deepEqual(result.field_retrieval_anchors,[{...anchors[0],text_sha256:semanticDigest(retained)}]);
    const fields=new Set(result.declaration_fields.map(item=>item.field));
    const claims=architectureGroundingClaims(result.architecture,[],new Set(),fields,result.field_retrieval_anchors).filter(item=>item.scope_context.field==='description');
    const planning=prepareArchitectureClaimSourceSelection({snapshot:{snapshot_id:'b'.repeat(64),files:[{path:'src/operation.ts',line_count:4,sha256:'a'.repeat(64)},{path:'scripts/complete.mjs',line_count:35,sha256:'c'.repeat(64)}]},native:{nodes:[],edges:[],evidence:[]},claims});
    assert.equal(planning.contexts.length,2);
    for(const context of planning.contexts)assert.ok(context.candidates.some(candidate=>candidate.definition_kind==='source_reference'&&candidate.path==='scripts/complete.mjs'&&candidate.line_start===1&&candidate.line_end===35),'surviving facts lost their prior complete witness');
    assert.deepEqual(result.architecture.modules,architecture.modules,'retrieval rebinding never changes publication evidence');
    assert.equal(semanticDigest({architecture,anchors}),before);
  }
});

test('full host span withdrawal removes its prior field anchors instead of binding them to the neutral placeholder',()=>{
  for(const qualified of [false,true]){
    const {architecture,plan,anchors}=spanRetractionFixture(qualified,true);
    const result=applyArchitectureGroundingRepairs(architecture,[],[],[],plan.span_withdrawals,anchors);
    assert.deepEqual(result.field_retrieval_anchors,[]);
    assert.deepEqual(result.withdrawn_fields,[{field:'description',node_id:'system'}]);
  }
});
