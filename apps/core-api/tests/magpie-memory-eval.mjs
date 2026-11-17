import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.argv[2];
assert.ok(['codex','dsh','opencode'].includes(host), 'Choose a member harness: codex, dsh, or opencode');
const mode = process.argv[3] ?? 'matrix';
assert.ok(mode === 'matrix' || (['holdout','documents'].includes(mode) && host === 'opencode') || (['defect','diversity','lifecycle','recovery','governance','native-capture'].includes(mode) && host === 'dsh'));
const governanceMode = ['governance','native-capture'].includes(mode);
const governanceRun = (mode === 'native-capture' ? process.env.TSP_NATIVE_CAPTURE_RUN_ID : process.env.TSP_PERSONAL_MEMORY_RUN_ID) ??
  (mode === 'native-capture' ? '20261112-native-capture-a' : '20261111-governance-a');
if (governanceMode) assert.match(governanceRun,/^[a-z0-9-]{8,64}$/u);
const label = process.env.TSP_HANDOFF_LABEL ?? 'initial';
if (mode === 'defect') assert.match(label, /^[a-z][a-z0-9-]{0,30}$/);
const model = 'workbuddy/deepseek-v4.1-flash';
const served = new Set([model, 'deepseek-v4.1-flash']);
const upstream = new URL(process.env.TSP_MAGPIE_BASE_URL ?? 'http://127.0.0.1:3425');
assert.ok(upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1' && !upstream.username && !upstream.password &&
  !upstream.search && !upstream.hash && ['/', '/v1', '/v1/'].includes(upstream.pathname), 'Choose the local Magpie listener');
const token = randomBytes(32).toString('hex');
const routes = new Set(['/v1/messages','/v1/chat/completions','/v1/responses']);
const audit = [];
const failures = [];
let rejectedLabeledPaths = 0;
const startedAt = new Date().toISOString();

// The harness must select all tools itself. Forward the complete request and response without translating prompts or tool calls.
const gateway = createServer(async (req,res) => {
  try {
    assert.equal(req.method,'POST');
    assert.ok(routes.has(req.url));
    assert.ok(req.headers.authorization === 'Bearer '+token || req.headers['x-api-key'] === token, 'Unrecognized caller');
    const chunks = [];
    let length = 0;
    for await (const data of req) {
      length += data.length;
      assert.ok(length <= 4*1024*1024, 'Unexpected request length');
      chunks.push(data);
    }
    const body = Buffer.concat(chunks);
    const request = JSON.parse(body.toString('utf8'));
    assert.equal(request.model,model,'Unexpected requested model');
    // Some harness profiles emit cwd in hidden message context even when
    // their runtime context option is disabled. Never reveal a condition or
    // an expected behavior through a descriptive experimental directory.
    if (['diversity','defect','lifecycle','recovery','documents'].includes(mode) &&
      /[\\/](?:case-[a-z0-9_-]+|pair-[0-9]+)-(?:dual|platform)(?=[\\/"\s]|$)/i.test(body.toString('utf8'))) {
      rejectedLabeledPaths++;
      throw Error('Experimental condition exposed through a directory name');
    }
    const headers = {'content-type':'application/json'};
    if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    const response = await fetch(new URL(req.url,upstream.origin),{
      method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(120_000),
    });
    const contentType = response.headers.get('content-type') ?? 'application/json';
    const modelIds = new Set();
    const observe = data => {
      let item;
      try { item = JSON.parse(data); } catch { return; }
      for (const envelope of [item, item?.response, item?.message]) {
        if (typeof envelope?.model === 'string') modelIds.add(envelope.model);
      }
    };
    res.writeHead(response.status,{'content-type':contentType,'cache-control':'no-store'});
    const decoder = new TextDecoder();
    let pending = '';
    for await (const part of response.body ?? []) {
      res.write(part);
      pending += decoder.decode(part,{stream:true});
      if (contentType.includes('event-stream')) {
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) if (line.startsWith('data:')) observe(line.slice(5).trim());
      }
    }
    pending += decoder.decode();
    if (pending.startsWith('data:')) observe(pending.slice(5).trim());
    else if (pending) observe(pending);
    audit.push({endpoint:req.url,status:response.status,models:[...modelIds]});
    res.end();
  } catch (error) {
    failures.push(error?.name ?? 'Error');
    if (!res.headersSent) res.writeHead(502,{'content-type':'application/json'});
    res.end('{"error":{"message":"Magpie evaluation request failed"}}');
  }
});

await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve));
const handoff = ['defect','diversity','lifecycle','recovery','documents'].includes(mode);
const variants = mode === 'documents' ? 'initial,current_revision' : mode === 'recovery' ? 'untracked,tracked' : mode === 'lifecycle' ? 'full,delta' : handoff ? 'off,on' :
  process.env.TSP_RETRIEVAL_VARIANTS || (host==='codex' ? 'tools,guided' : 'tools,native');
const env = {...process.env,TSP_RETRIEVAL_HOST:host,TSP_RETRIEVAL_VARIANTS:variants,
  TSP_EVAL_MODEL:model,TSP_EVAL_FAMILY:'deepseek-v4.1-flash',
  TSP_EVAL_GATEWAY_URL:'http://127.0.0.1:'+gateway.address().port+'/v1',TSP_EVAL_GATEWAY_TOKEN:token};
if (governanceMode) Object.assign(env,{TSP_MEMORY_PROVIDER:'openai',TSP_MEMORY_BASE_URL:env.TSP_EVAL_GATEWAY_URL,
  TSP_MEMORY_API_KEY:token,TSP_MEMORY_MODEL:model});
const args = governanceMode ? ['--run-id',governanceRun,...(process.env.TSP_PERSONAL_MEMORY_OPENCODE==='1'?['--include-opencode']:[])]
  : handoff ? [] : mode==='matrix' ? ['--active-retrieval','--record-retrieval'] : ['--opencode-holdout'];
const script = mode === 'native-capture' ? 'native-memory-native-capture-e2e.mjs' : mode === 'governance' ? 'native-memory-personal-governance.mjs' : mode === 'documents' ? 'native-memory-document-handoff.mjs' : mode === 'recovery' ? 'native-memory-recovery.mjs' : mode === 'lifecycle' ? 'native-memory-lifecycle.mjs' : mode === 'diversity' ? 'native-memory-diversity.mjs' : mode === 'defect' ? 'native-memory-defect-handoff.mjs' : 'native-memory-live.mjs';
const entry = fileURLToPath(new URL(script,import.meta.url));
let code;
try {
  const child = spawn(process.execPath,[entry,...args],{env,stdio:'inherit',windowsHide:true});
  [code] = await once(child,'exit');
} finally {
  gateway.closeAllConnections();
  await new Promise(resolve=>gateway.close(resolve));
}
const successful = audit.filter(r=>r.status===200);
const confirmed = successful.filter(r=>r.models.length && r.models.every(id=>served.has(id)));
const report = {host,mode,variants,requestedModel:model,startedAt,endedAt:new Date().toISOString(),
  childExitCode:code,requests:audit.length,successfulRequests:successful.length,modelVerifiedResponses:confirmed.length,
  observedModels:[...new Set(audit.flatMap(r=>r.models))],endpoints:[...new Set(audit.map(r=>r.endpoint))],
  statuses:audit.reduce((counts,r)=>({...counts,[r.status]:(counts[r.status]??0)+1}),{}),transportFailures:failures.length,
  ...(handoff ? {checkedForDescriptivePaths:true, rejectedLabeledPaths} : {})};
const filename = mode === 'documents' ? '../memory-project-documents/handoff-magpie-audit.json' : mode === 'recovery' ? 'recovery/magpie-audit.json' : mode === 'lifecycle' ? 'lifecycle/magpie-audit.json' : handoff ? 'defect-handoff/magpie-'+(mode === 'diversity' ? 'diversity' : label)+'-audit.json' : 'magpie-'+host+'-'+mode+'-audit.json';
const file = governanceMode ? new URL('../../../docs/experiments/'+(mode === 'native-capture' ? 'native-session-capture/' : 'personal-memory-governance/')+governanceRun+'/magpie-audit.json',import.meta.url)
  : new URL('../../../docs/experiments/memory-harness-pilot/'+filename,import.meta.url);
await mkdir(path.dirname(fileURLToPath(file)),{recursive:true});
await writeFile(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
assert.equal(code,0,'Member evaluation did not complete');
assert.ok(successful.length && confirmed.length===successful.length && !failures.length,'Provider model could not be attested');
