// Observation-only stdio relay for the handoff evaluation. The member still runs the shipped CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const writeAudit = (path, entry) => appendFileSync(path, JSON.stringify(entry) + '\n', {mode:0o600});
const rows = values => Array.isArray(values) ? values.filter(r => typeof r?.source === 'string').map(r => ({
  source:r.source, scope:r.scope, state:r.state,
  textHash:typeof r.text === 'string' ? createHash('sha256').update(r.text).digest('hex') : null,
})) : [];

// Installed only in the CLI child, so headers are observed on the original network request.
function observeFetch(audit) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (/\/memory\/search$/.test(path)) {
      const headers = new Headers(init?.headers);
      headers.set('X-TSP-Memory-Explain','1');
      init = {...init,headers};
    }
    const response = await original(input, init);
    if (/\/memory\/(?:search|brief)$/.test(path)) {
      const {query,scope} = JSON.parse(init.body);
      const result = await response.clone().json();
      const matches=response.headers.get('X-TSP-Memory-Matches');
      writeAudit(audit, {kind:'http', operation:path.endsWith('/search')?'search':'brief', query,scope,status:response.status,
        retrieval:response.headers.get('X-TSP-Memory-Retrieval'),engines:response.headers.get('X-TSP-Memory-Engines'),
        matches:matches ? JSON.parse(matches) : null, rows:rows(result.data)});
    }
    return response;
  };
}

async function relay(audit) {
  const env = Object.fromEntries(['PATH','SystemRoot','AGENTCTL_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','HOME']
    .filter(k => process.env[k]).map(k => [k,process.env[k]]));
  const child = spawn(process.execPath, ['--import',import.meta.url,cli,'memory','mcp'], {
    stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...env,TSP_HANDOFF_HTTP_AUDIT:audit},
  });
  const done = once(child,'close');
  const pending = new Map();
  const input = createInterface({input:process.stdin});
  input.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined) pending.set(msg.id,msg);
    child.stdin.write(line + '\n');
  });
  input.on('close', () => child.stdin.end());
  try {
    for await (const line of createInterface({input:child.stdout})) {
      const msg = JSON.parse(line);
      const req = pending.get(msg.id);
      pending.delete(msg.id);
      if (req && ['tools/call','resources/read'].includes(req.method)) {
        const blocks = msg.result?.content ?? msg.result?.contents ?? [];
        const result = blocks.flatMap(block => {
          try {return rows(JSON.parse(block.text));} catch {return [];}
        });
        writeAudit(audit,{kind:'mcp',name:req.params?.name ?? req.params?.uri,query:req.params?.arguments?.query,
          scope:req.params?.arguments?.scope,error:Boolean(msg.error || msg.result?.isError),rows:result});
      }
      process.stdout.write(line + '\n');
    }
    const [code] = await done;
    assert.equal(code,0,'Member MCP did not close successfully');
  } finally {
    input.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

if (process.env.TSP_HANDOFF_HTTP_AUDIT) observeFetch(process.env.TSP_HANDOFF_HTTP_AUDIT);
else if (process.argv[2] === '--mcp') await relay(process.argv[3]);
