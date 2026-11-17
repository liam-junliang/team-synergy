import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { appendFile, readFile, writeFile, stat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const exec = promisify(execFile);

export async function startObserver({ outputDir, pids = [], openviking, logs = [] }) {
  const outputPath = path.join(outputDir, 'resources.jsonl');
  await writeFile(outputPath, '', { flag: 'wx' });
  const positions = await Promise.all(logs.map(async file => ({ file, size: (await stat(file)).size })));
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./sample-resources.ps1', import.meta.url))];
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, TSP_PERF_SAMPLE: JSON.stringify({ outputPath, pids: [...new Set([...pids, process.pid])] }) } });
  const closed = once(child, 'close');
  let active = false, timer;
  const queue = async () => {
    if (active || !openviking) return;
    active = true;
    try {
      const response = await fetch(openviking.baseUrl.replace(/\/$/u, '') + '/api/v1/observer/queue?format=json',
        { headers: { 'x-api-key': openviking.apiKey }, signal: AbortSignal.timeout(2500), redirect: 'error' });
      const body = await response.json();
      const source = body.result?.status?.summary;
      const summary = {};
      for (const key of ['pending', 'in_progress', 'processed', 'requeued', 'errors', 'total']) {
        if (Number.isFinite(source?.[key])) summary[key] = source[key];
      }
      await appendFile(path.join(outputDir, 'queue.jsonl'), JSON.stringify({ at: new Date().toISOString(), status: response.status,
        summary, sharedEnvironment: true }) + '\n');
    } catch { await appendFile(path.join(outputDir, 'queue.jsonl'), JSON.stringify({ at: new Date().toISOString(), error: 'queue_observation_failed' }) + '\n'); }
    finally { active = false; }
  };
  await queue();
  timer = setInterval(() => { void queue(); }, 5000);
  return {
    phaseHook: async event => { await appendFile(path.join(outputDir, 'phases.jsonl'), JSON.stringify(event) + '\n'); },
    async stop() {
      clearInterval(timer);
      while (active) await new Promise(resolve => setTimeout(resolve, 20));
      await writeFile(outputPath + '.stop', 'stop');
      let stopTimer;
      const code = await Promise.race([closed.then(([exit]) => exit), new Promise(resolve => { stopTimer = setTimeout(() => { child.kill(); resolve('terminated_after_stop_timeout'); }, 15000); })]);
      clearTimeout(stopTimer);
      const counts = [];
      const patterns = { sqliteBusy: /SQLITE_BUSY/giu, sqliteLocked: /database (?:is )?locked/giu,
        embeddingError: /(?:embedding|embed)[^\r\n]{0,100}(?:fail|error|timeout)|(?:fail|error)[^\r\n]{0,100}(?:embedding|embed)/giu,
        timeout: /timeout|timed out/giu,
        http429: /(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:Code|_code)?["']?\s*[:=]\s*)429\b/giu,
        http503: /(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:Code|_code)?["']?\s*[:=]\s*)503\b/giu };
      for (const position of positions) {
        const size = (await stat(position.file)).size;
        const start = size < position.size ? 0 : position.size;
        const length = Math.min(Math.max(0, size - start), 4 * 1024 * 1024);
        const handle = await open(position.file, 'r');
        const bytes = Buffer.alloc(length);
        try { await handle.read(bytes, 0, length, size - length); } finally { await handle.close(); }
        const text = bytes.toString('utf8');
        counts.push({ file: path.basename(position.file), newBytes: Math.max(0, size - start), scannedBytes: length,
          rotated: size < position.size, counts: Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, [...text.matchAll(pattern)].length])) });
      }
      const report = { stoppedAt: new Date().toISOString(), samplerExitCode: code, logs: counts,
        limitations: ['Process I/O counters include socket and pipe I/O; they are not physical disk throughput.',
          'Observer queue counters and GPU utilization include activity outside the isolated benchmark resources.',
          'Log counts are heuristic; absence of a logged SQLite error is not proof of absent lock wait.'] };
      await writeFile(path.join(outputDir, 'observation.json'), JSON.stringify(report, null, 2));
      return report;
    },
  };
}

export async function discoverWindowsTargets(ports) {
  const command = `$ports=ConvertFrom-Json $env:TSP_PERF_PORTS; $rows=@(foreach($port in $ports){Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue | Select-Object @{n='port';e={$port}},OwningProcess,LocalAddress}); ConvertTo-Json -InputObject $rows -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true,
    env: { ...process.env, TSP_PERF_PORTS: JSON.stringify(ports) }, maxBuffer: 65536 });
  return JSON.parse(stdout.trim() || '[]');
}

export async function loadJson(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, '')); }
