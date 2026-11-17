// Local, synthetic experiment. The model receives messages but never the expected answers.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const dir = new URL('./', import.meta.url);
const cases = JSON.parse(await readFile(new URL('cases.json', dir), 'utf8'));
const [policy = 'baseline', split = 'development'] = process.argv.slice(2);
if (!['baseline', 'scoped', 'bound'].includes(policy) || !['development','holdout'].includes(split)) throw Error('Unexpected experiment variant');
const base = 'http://127.0.0.1:11434/api/';
const model = 'hub-qwen2.5:latest';
const policyText = await readFile(new URL(policy + '.txt', dir), 'utf8');
const tags = await (await fetch(base+'tags', {redirect:'error',signal:AbortSignal.timeout(5000)})).json();
const digest = tags.models.find(m => m.name === model)?.digest;
if (!digest) throw Error('Expected local model is missing');
const schema = { type:'object', required:['items'], properties:{items:{type:'array',items:{
  type:'object', required:['audience','kind','message','quote'], properties:{
    audience:{enum:['project','private','session']},kind:{enum:['idea','decision','implemented','preference','instruction']},
    message:{type:'string'},quote:{type:'string'}
  }
}}}};
const report = { policy, split, model, digest, promptHash:createHash('sha256').update(policyText).digest('hex'), cases:[] };
for (const sample of cases.filter(c => c.set === split)) {
  // The capture adapter supplies the identities. Constrain the decoder to those
  // references and to valid scope/state pairs before checking the actual span.
  const format = policy === 'bound' ? {type:'object',required:['items'],properties:{
    items:{type:'array',items:{type:'object',required:['sourceId','label','quote'],properties:{
      sourceId:{enum:sample.messages.map(m=>m.id)},label:{enum:['project/idea','project/decision','project/implemented','private/preference','session/instruction']},quote:{type:'string'}
    }}}
  }} : schema;
  const response = await fetch(base+'chat',{method:'POST',redirect:'error',signal:AbortSignal.timeout(150000),
    headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,format,
    messages:[{role:'system',content:policyText},{role:'user',content:JSON.stringify(sample.messages)}],
    options:{temperature:0,seed:73,num_ctx:4096,num_predict:384}})});
  if (!response.ok) throw Error('Local inference HTTP '+response.status);
  const raw = await response.json();
  let items;
  try { items=JSON.parse(raw.message.content).items; } catch { items=null; }
  const problems=[];
  if (!Array.isArray(items)) { problems.push('invalid output'); items=[]; }
  if (policy === 'bound') items = items.map(item=>{
    const [audience,kind] = String(item.label).split('/');
    return {audience,kind,message:item.sourceId,quote:item.quote};
  });
  for (const item of items) {
    if (!sample.messages.some(m=>m.id===item.message && typeof item.quote==='string' && item.quote.length && m.text.includes(item.quote))) problems.push('unattributed quote');
    if (item.audience==='project' && sample.private.some(marker => item.quote?.includes(marker))) problems.push('private clause in project output');
    if (!sample.expect.some(([dest,kind,id])=>dest===item.audience && kind===item.kind && id===item.message)) problems.push('unexpected classification');
  }
  for (const [dest,kind,id,anchor] of sample.expect) {
    if(!items.some(x=>x.audience===dest && x.kind===kind && x.message===id && x.quote?.includes(anchor))) problems.push('missing '+dest+'/'+kind);
  }
  report.cases.push({id:sample.id,items,problems:[...new Set(problems)],pass:!problems.length});
  console.log(sample.id,problems.length ? 'MISS' : 'PASS');
}
report.passed=report.cases.filter(c=>c.pass).length;
report.total=report.cases.length;
await writeFile(new URL(policy+'-'+split+'.json',dir),JSON.stringify(report,null,2)+'\n');
console.log(report.passed+'/'+report.total);
