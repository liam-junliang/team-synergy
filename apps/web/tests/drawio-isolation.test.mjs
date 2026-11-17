import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const browserBin = [process.env.TSP_TEST_BROWSER_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path));

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// The Node 22 WebSocket client speaks directly to the existing browser. The
// fixture never disables the browser sandbox or uses a downloaded driver.
async function connectCdp(endpoint, remaining, observe) {
  const socket = new WebSocket(endpoint), pending = new Map(), listeners = new Map();
  let sequence = 0;
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id); pending.delete(message.id);
      if (message.error) entry?.reject(new Error('CDP ' + message.error.message)); else entry?.resolve(message.result);
    } else {
      observe(message);
      const key = message.sessionId + ':' + message.method;
      listeners.get(key)?.(message.params); listeners.delete(key);
    }
  });
  socket.addEventListener('close', () => fail(new Error('Browser CDP connection closed')));
  socket.addEventListener('error', () => fail(new Error('Browser CDP connection failed')));
  await bounded(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Browser CDP connection failed')), { once: true });
  }), remaining(), 'Browser CDP connection timed out');
  return {
    command(method, params = {}, sessionId) {
      const id = ++sequence;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return bounded(response, remaining(), 'Browser CDP command timed out: ' + method);
    },
    event(method, sessionId) { return new Promise(resolve => listeners.set(sessionId + ':' + method, resolve)); },
    closeBrowser() { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' })); },
    dispose() { fail(new Error('Browser fixture disposed')); socket.close(); },
  };
}

// Uses an existing Chromium binary; no browser package, download or model service.
async function isolationFixture({ postResult = true, resultTimeout } = {}) {
    const profile = await mkdtemp(join(tmpdir(), 'team-synergy-drawio-browser-'));
    const deadline = Date.now() + 20000, remaining = () => Math.max(1, deadline - Date.now());
    const diagnostics = { phase: 'fixture-start', parentRequests: 0, childRequests: 0, events: [], stderr: '', stdout: '' };
    const child = createServer((_request, response) => {
      diagnostics.childRequests++;
      response.setHeader('Content-Type', 'text/html');
      response.end(`<script>
        const probe = fn => { try { fn(); return false; } catch { return true; } };
        localStorage.setItem('drawio-own-origin', 'available');
        const result = {
          parentStorageBlocked: probe(() => parent.localStorage.getItem('drawio-parent-storage')),
          parentCookieBlocked: probe(() => parent.document.cookie),
          sandboxRemovalBlocked: probe(() => frameElement.removeAttribute('sandbox')),
          ownStorageAvailable: localStorage.getItem('drawio-own-origin') === 'available',
          parentCookieNotShared: !document.cookie.includes('drawio_parent_cookie=')
        };
        if (${postResult}) parent.postMessage(JSON.stringify(result), ${JSON.stringify('http://127.0.0.1:PARENT')}.replace('PARENT', location.hash.slice(1)));
      </script>`);
    });
    const parent = createServer((_request, response) => {
      diagnostics.parentRequests++;
      const childOrigin = `http://localhost:${child.address().port}`;
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Set-Cookie', 'drawio_parent_cookie=fixture; Path=/; SameSite=Lax');
      response.end(`<pre id="result">pending</pre><script>
        localStorage.setItem('drawio-parent-storage', 'fixture');
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
        frame.referrerPolicy = 'no-referrer';
        window.addEventListener('message', event => {
          if (event.origin !== ${JSON.stringify(childOrigin)} || event.source !== frame.contentWindow) return;
          const result = JSON.parse(event.data);
          result.sandboxStillPresent = frame.getAttribute('sandbox') === 'allow-scripts allow-same-origin allow-downloads';
          document.getElementById('result').textContent = JSON.stringify(result);
        });
        frame.src = ${JSON.stringify(childOrigin)} + '/#' + location.port;
        document.body.append(frame);
      </script>`);
    });
    let chrome, cdp, exited, failure, cleanupError, result;
    try {
      for (const [server, host] of [[child, 'localhost'], [parent, '127.0.0.1']]) {
        await bounded(new Promise((resolve, reject) => {
          server.once('error', reject); server.listen(0, host, resolve);
        }), remaining(), 'Browser fixture HTTP server did not start');
      }
      diagnostics.phase = 'browser-start';
      const endpoint = new Promise((resolve, reject) => {
        chrome = spawn(browserBin, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
          '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
          '--remote-debugging-address=127.0.0.1', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        exited = new Promise(resolve => {
          chrome.once('exit', (code, signal) => resolve({ code, signal }));
          chrome.once('error', error => resolve({ spawnError: error.code }));
        });
        chrome.once('error', reject);
        chrome.once('exit', (code, signal) => reject(new Error(`Browser exited before DevTools: ${code}/${signal}`)));
        chrome.stdout.on('data', chunk => { diagnostics.stdout = (diagnostics.stdout + chunk).slice(-4096); });
        chrome.stderr.on('data', chunk => {
          diagnostics.stderr = (diagnostics.stderr + chunk).slice(-4096);
          const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/u.exec(diagnostics.stderr);
          if (match) resolve(match[1]);
        });
      });
      const address = await bounded(endpoint, remaining(), 'Browser did not expose DevTools');
      diagnostics.phase = 'cdp-connect';
      cdp = await connectCdp(address, remaining, message => {
        if (['Page.frameNavigated', 'Runtime.exceptionThrown', 'Inspector.targetCrashed'].includes(message.method)) {
          diagnostics.events.push({ method: message.method, detail: message.params?.exceptionDetails?.text ?? message.params?.frame?.url });
          diagnostics.events = diagnostics.events.slice(-8);
        }
      });
      diagnostics.browser = (await cdp.command('Browser.getVersion')).product;
      const { targetId } = await cdp.command('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.command('Target.attachToTarget', { targetId, flatten: true });
      await cdp.command('Page.enable', {}, sessionId);
      await cdp.command('Runtime.enable', {}, sessionId);
      diagnostics.phase = 'page-load';
      const loaded = cdp.event('Page.loadEventFired', sessionId);
      const navigation = await cdp.command('Page.navigate', { url: `http://127.0.0.1:${parent.address().port}/` }, sessionId);
      assert.ok(!navigation.errorText, navigation.errorText);
      await bounded(loaded, remaining(), 'Browser fixture page did not load');
      diagnostics.phase = 'isolation-result';
      // Wait for the real parent postMessage handler to update its result.
      // No virtual clock, fixed delay, iframe privilege change or synthetic result.
      const evaluated = await bounded(cdp.command('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `
        new Promise(resolve => {
          let observer;
          const read = () => {
            const text = document.getElementById('result')?.textContent;
            if (text && text !== 'pending') { observer?.disconnect(); resolve(text); }
          };
          observer = new MutationObserver(read);
          observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
          read();
        })` }, sessionId), Math.min(remaining(), resultTimeout ?? Infinity), 'Browser isolation result did not arrive');
      assert.ok(!evaluated.exceptionDetails, JSON.stringify(evaluated.exceptionDetails));
      assert.equal(typeof evaluated.result?.value, 'string', 'browser must render the isolation result');
      result = JSON.parse(evaluated.result.value);
    } catch (error) {
      failure = new Error(`${error.message}; fixture=${JSON.stringify(diagnostics)}`, { cause: error });
      failure.phase = diagnostics.phase;
    } finally {
      try {
        if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
          cdp?.closeBrowser();
          try { await bounded(exited, 1000, 'Browser did not close'); }
          catch { chrome.kill('SIGKILL'); await bounded(exited, 1000, 'Browser did not exit after termination'); }
        }
        diagnostics.processExited = !chrome?.pid || chrome.exitCode !== null || chrome.signalCode !== null;
        if (chrome) diagnostics.exit = await exited;
      } catch (error) {
        cleanupError = error;
        if (failure) failure.message += '; cleanup=' + error.message;
      } finally {
        cdp?.dispose(); chrome?.stdout.destroy(); chrome?.stderr.destroy();
        await Promise.all([parent, child].map(server => new Promise(resolve => {
          server.close(resolve); server.closeAllConnections();
        })));
      }
      assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
      assert.ok(profile.includes('team-synergy-drawio-browser-'));
      await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
      if (failure) failure.cleanupComplete = diagnostics.processExited;
    }
    if (failure) throw failure;
    if (cleanupError) throw new Error(`Browser cleanup failed: ${cleanupError.message}; fixture=${JSON.stringify(diagnostics)}`);
    return { result, diagnostics };
}

test('external-origin sandbox retains its own origin but cannot read parent storage/cookies or remove its sandbox',
  { skip: !browserBin, timeout: 25000 }, async t => {
    const { result, diagnostics } = await isolationFixture();
    assert.equal(diagnostics.exit.code, 0, JSON.stringify(diagnostics));
    assert.deepEqual(result, { parentStorageBlocked: true, parentCookieBlocked: true, sandboxRemovalBlocked: true,
      ownStorageAvailable: true, parentCookieNotShared: true, sandboxStillPresent: true });
    t.diagnostic(JSON.stringify({ browser: diagnostics.browser, processExited: diagnostics.processExited,
      parentRequests: diagnostics.parentRequests, childRequests: diagnostics.childRequests }));
  });

test('a missing iframe result reports its phase and closes the real browser within the fixture deadline',
  { skip: !browserBin, timeout: 25000 }, async () => {
    await assert.rejects(isolationFixture({ postResult: false, resultTimeout: 150 }), error => {
      assert.equal(error.phase, 'isolation-result');
      assert.equal(error.cleanupComplete, true);
      assert.match(error.message, /isolation result did not arrive/);
      assert.match(error.message, /"parentRequests":[1-9]/);
      assert.match(error.message, /"childRequests":[1-9]/);
      assert.match(error.message, /"stderr":/);
      return true;
    });
  });
