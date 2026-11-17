import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const script = resolve(import.meta.dirname, 'memory-embedding-cpu.ps1');

for (const action of ['start', 'status', 'stop']) {
  test(`CPU embedding ${action} rejects an unrelated healthy listener`, { skip: process.platform !== 'win32' }, async t => {
    const runtime = await mkdtemp(resolve(tmpdir(), 'tsp-cpu-embedding-'));
    const server = createServer((_req, res) => res.end('{"version":"0.14.2"}'));
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    t.after(async () => {
      await new Promise(done => server.close(done));
      assert.ok(relative(resolve(tmpdir()), runtime).startsWith('tsp-cpu-embedding-'));
      await rm(runtime, { recursive: true, force: true });
    });
    const port = server.address().port;
    await writeFile(resolve(runtime, 'deployment.json'), JSON.stringify({
      pid: process.pid, executable: process.execPath, baseUrl: `http://127.0.0.1:${port}`, createdAt: new Date().toISOString(),
    }));
    let failure;
    try { await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action,
      '-RuntimeRoot', runtime, '-Port', String(port)], { windowsHide: true, timeout: 30000 }); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 1);
    assert.match(failure.stderr, /ownership|owned|unrelated/iu);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/version`)).status, 200);
  });
}
