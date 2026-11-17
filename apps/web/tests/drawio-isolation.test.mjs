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

// Uses an existing Chromium binary; no browser package, download or model service.
test('external-origin sandbox retains its own origin but cannot read parent storage/cookies or remove its sandbox',
  { skip: !browserBin, timeout: 25000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'team-synergy-drawio-browser-'));
    const child = createServer((_request, response) => {
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
        parent.postMessage(JSON.stringify(result), ${JSON.stringify('http://127.0.0.1:PARENT')}.replace('PARENT', location.hash.slice(1)));
      </script>`);
    });
    const parent = createServer((_request, response) => {
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
    let chrome;
    try {
      await new Promise(resolve => child.listen(0, 'localhost', resolve));
      await new Promise(resolve => parent.listen(0, '127.0.0.1', resolve));
      chrome = spawn(browserBin, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
        '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=3000',
        `http://127.0.0.1:${parent.address().port}/`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      chrome.stdout.on('data', chunk => { output += chunk; });
      chrome.stderr.resume();
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { chrome.kill(); reject(new Error('Browser isolation fixture timed out')); }, 20000);
        chrome.once('error', error => { clearTimeout(timer); reject(error); });
        chrome.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0);
      const match = /<pre id="result">([^<]+)<\/pre>/.exec(output);
      assert.ok(match, 'browser must render the isolation result');
      assert.deepEqual(JSON.parse(match[1]), { parentStorageBlocked: true, parentCookieBlocked: true, sandboxRemovalBlocked: true,
        ownStorageAvailable: true, parentCookieNotShared: true, sandboxStillPresent: true });
    } finally {
      if (chrome && chrome.exitCode === null) chrome.kill();
      await Promise.all([new Promise(resolve => parent.close(resolve)), new Promise(resolve => child.close(resolve))]);
      assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
      assert.ok(profile.includes('team-synergy-drawio-browser-'));
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
