import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../dist/index.js',import.meta.url));
export async function harnessFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-persistent-harness-'));
  const cwd = path.join(root, 'workspace'), member = path.join(root, 'member'), home = path.join(root, 'host');
  for (const directory of [path.join(cwd, '.agent'), member, path.join(home, 'sessions')]) mkdirSync(directory, { recursive: true });
  const posts = [], children = new Set(), receipts = new Set(); let authorized = true;
  let preflight = { serviceEnabled: true, allowed: true, reason: null };
  let captureStatus = 'pending', deliveryFailure = false;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!authorized || req.headers.authorization !== 'Bearer synthetic-device') {
      res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: { code: 'login_required', message: 'fixture' } })); return;
    }
    let data;
    if (req.url === '/auth/whoami') data = { user_code: 'fixture-owner' };
    else if (req.url === '/projects/P/memory/binding') data = {};
    else if (req.url === '/projects/P/memory/capture-preflight') data = preflight;
    else if (req.url === '/projects/P/memory/capture-events') {
      let input = ''; for await (const chunk of req) input += chunk;
      if (deliveryFailure) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, error: { code: 'fixture_delivery_unavailable', message: 'PRIVATE-SERVER-ERROR' } })); return;
      }
      const body = JSON.parse(input); posts.push(body);
      const captureCode = String(posts.length).padStart(20, '0');
      receipts.add(captureCode);
      data = { captureCode, status: 'pending' };
    } else if (req.url?.startsWith('/projects/P/memory/captures/')) {
      const captureCode = req.url.split('/').at(-1);
      if (!captureStatus || !receipts.has(captureCode)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: { code: 'memory_capture_not_found', message: 'fixture' } })); return;
      }
      data = { captureCode, status: captureStatus, result: { text: 'PRIVATE-SERVER-RESULT' },
        ...(captureStatus === 'skipped' ? { error: { code: 'memory_no_material', message: 'PRIVATE-SERVER-ERROR' } } : {}) };
    } else { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ ok: true, data }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}`;
  const auth = { api_url: api, user_code: 'fixture-owner', device_token: 'synthetic-device', device_name: 'fixture' };
  writeFileSync(path.join(member, 'auth.json'), JSON.stringify(auth));
  writeFileSync(path.join(cwd, '.agent', 'bound-project.yaml'), `project_code: P\napi_url: ${api}\nbound_at: fixture\n`);
  const runtime = path.join(root, 'runtime.mjs'); writeFileSync(runtime, "console.log('codex-cli 0.145.0');\n");
  const env = { ...process.env, AGENTCTL_HOME: member, ACP_API_URL: api };
  async function run(args, input, extra = {}) {
    const child = spawn(process.execPath, [cli, 'memory', 'native', ...args], { cwd, env: { ...env, ...extra }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); const done = once(child, 'close'); let output = '', error = '';
    child.stdout.setEncoding('utf8').on('data', chunk => output += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => error += chunk);
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
    const [code] = await done; children.delete(child);
    return { code, value: JSON.parse(output), error };
  }
  const install = async (name = 'codex', custom = {}) => run(['install', '--harness', name, '--host-home', home, '--runtime', runtime,
    ...Object.entries(custom).flatMap(([key, value]) => [key, value])]);
  t.after(async () => {
    for (const child of children) child.kill();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    // Detached delivery children may release their cwd just after their ACK.
    // Retry only Windows filesystem cleanup; assertions and capture never retry.
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  return { root, cwd, home, member, runtime, env, auth, posts, install, run, setAuthorized: value => { authorized = value; },
    setPreflight: value => { preflight = value; }, setCaptureStatus: value => { captureStatus = value; },
    setDeliveryFailure: value => { deliveryFailure = value; } };
}
