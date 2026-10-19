import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, config, agent;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [config, agent] = await Promise.all(['platformClientConfig.ts', 'AgentWorkspace.tsx'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => vite?.close());

test('connection commands use configured public addresses and preserve a distinct browser origin', () => {
  const current = 'http://127.0.0.1:5173';
  const empty = { public_web_url: null, public_api_url: null };
  assert.equal(config.cliLoginCommand(empty, current), `tsp auth login --api ${current}/api\ntsp auth whoami`);
  assert.equal(config.cliLoginCommand({ ...empty, public_web_url: 'https://teams.example' }, current), 'tsp auth login --api https://teams.example/api --web https://teams.example\ntsp auth whoami');
  assert.equal(config.cliLoginCommand({ ...empty, public_api_url: 'https://core.example/v1' }, current), `tsp auth login --api https://core.example/v1 --web ${current}\ntsp auth whoami`);
  assert.equal(config.cliLoginCommand({ public_web_url: 'https://teams.example', public_api_url: 'https://core.example/api' }, current), 'tsp auth login --api https://core.example/api --web https://teams.example\ntsp auth whoami');
  for (const url of ['https://host/api;run', 'https://host/$(run)', 'https://host/`run`', 'https://host/api\nrun', 'https://host/"test"']) {
    assert.throws(() => config.cliLoginCommand({ ...empty, public_api_url: url }, current), /Invalid platform/);
  }
});

test('configuration is read only from the authenticated same-origin API, never from configured external hosts', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true, data: { public_web_url: 'https://public.example', public_api_url: 'https://api.example' } }));
  };
  try {
    assert.equal((await config.getPlatformClientConfig()).public_api_url, 'https://api.example');
    assert.deepEqual(calls, ['/api/platform/client-config']);
  } finally { globalThis.fetch = previous; }
});

test('the CLI guide waits for settings instead of offering potentially incorrect local connection commands', () => {
  function render(settings) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    if (settings) client.setQueryData(config.PLATFORM_CLIENT_CONFIG_QUERY_KEY, settings);
    try {
      return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(agent.CliConnectionGuide, { user: { code: 'U', account: 'member', display_name: 'Member' } })));
    } finally { client.clear(); }
  }
  assert.doesNotMatch(render(), /tsp auth login|Invoke-WebRequest|curl -fsSL/);
  const html = render({ public_web_url: 'https://teams.example', public_api_url: 'https://api.example/core' });
  assert.match(html, /tsp auth login --api https:\/\/api.example\/core --web https:\/\/teams.example/);
  assert.doesNotMatch(html, /127\.0\.0\.1/);
});
