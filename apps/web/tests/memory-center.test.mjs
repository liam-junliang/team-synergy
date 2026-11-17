import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, ui, api, personalApi;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [ui, api, personalApi] = await Promise.all(['MemoryCenterWorkbench.tsx', 'memoryCenterApi.ts', 'personalMemoryApi.ts'].map(file => vite.ssrLoadModule('/src/' + file)));
});
after(async () => { await vite?.close(); });
const elements = node => Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : [];
const view = (changes = {}) => ({ ownerCode: 'ALICE', projects: [{ code: 'PROJECT-A', name: '可见项目', status: 'active', indexes: 31, syncedIndexes: 31 }],
  personal: { active: 0, withdrawn: 0, total: 0 }, captures: { total: 0, counts: { pending: 0, processing: 0, completed: 0, skipped: 0, needs_clarification: 0, failed: 0 },
    recent: [], truncated: false, installation: 'unknown', localQueue: 'unknown' }, serviceEnabled: true, observedAt: '2026-11-17T10:00:00Z',
  model: { provider: 'openai', model: 'officeace/deepseek-v4.1-flash', providerSource: 'explicit', modelSource: 'explicit', observationScope: 'system_admin_only' }, ...changes });

test('empty capture and model panels distinguish server receipt, unknown integration, and actual provider configuration', () => {
  const html = renderToStaticMarkup(createElement(ui.MemoryCaptureSummary, { value: view() }));
  assert.match(html, /尚未收到事件/); assert.match(html, /客户端接入状态：未知/); assert.match(html, /0 个事件不代表已启用/);
  assert.doesNotMatch(html, /Hook 已启用|Hook 未安装|已经自动采集/);
  const model = renderToStaticMarkup(createElement(ui.MemoryModelPanel, { value: view() }));
  assert.match(model, /officeace\/deepseek-v4.1-flash/); assert.match(model, /显式配置/); assert.match(model, /逐事件模型调用证明/);
  assert.doesNotMatch(model, /实际请求|响应解析成功|管理员服务级观测|127\.0\.0\.1|api[_ -]?key/i);
  const defaults = view({ model: { provider: 'ollama', model: 'hub-qwen2.5:latest', providerSource: 'default', modelSource: 'default' } });
  assert.match(renderToStaticMarkup(createElement(ui.MemoryModelPanel, { value: defaults })), /默认值/);
});

test('overview counts an index once and provides working navigation to all four views', () => {
  const targets = [];
  const tree = ui.MemoryCenterOverview({ value: view(), onSelect: tab => targets.push(tab) });
  const html = renderToStaticMarkup(tree);
  assert.match(html, />31<\/p>/); assert.doesNotMatch(html, />62<\/p>/); assert.match(html, /同步就绪不等于方案已确认/);
  for (const node of elements(tree).filter(node => node.type === 'button')) node.props.onClick();
  assert.deepEqual(targets, ['projects', 'projects', 'personal', 'processing', 'processing']);
  const tabs = ui.MemoryCenterTabs({ selected: 'personal', onSelect: tab => targets.push(tab), disabled: true });
  const buttons = elements(tabs).filter(node => node.type === 'button');
  assert.equal(buttons.length, 4); assert.equal(buttons.filter(node => node.props.disabled).length, 3);
});

test('actual workbench switches tabs to processing metadata while account cache isolation prevents another user exposure', () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(api.memoryCenterKey('ALICE'), view());
  let stage = 0;
  function Probe() {
    const [, refresh] = useState(0);
    const tree = ui.MemoryCenterWorkbench({ ownerCode: 'ALICE' });
    const nav = elements(tree).find(node => node.type === ui.MemoryCenterTabs);
    if (stage === 0) { stage++; nav.props.onSelect('processing'); }
    else if (stage === 1) { stage++; assert.equal(nav.props.selected, 'processing'); refresh(1); }
    return tree;
  }
  try {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
    assert.equal(stage, 2); assert.match(html, /模型整理与观测/); assert.match(html, /尚无事件/);
    const foreign = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ui.MemoryCenterWorkbench, { ownerCode: 'BOB' })));
    assert.doesNotMatch(foreign, /可见项目|officeace|>31<\/p>/); assert.match(foreign, /正在读取记忆中心/);
    assert.notDeepEqual(api.memoryCenterKey('ALICE'), api.memoryCenterKey('BOB'));
    assert.notDeepEqual(personalApi.personalMemoryListKey('ALICE', 'all'), personalApi.personalMemoryListKey('BOB', 'all'));
  } finally { client.clear(); }
});

test('administrator model totals are explicitly service-process scoped, never presented as personal history', () => {
  const value = view(); value.model.observation = { scope: 'service_process', startedAt: '2026-11-17T10:00:00Z', attempts: 3, successes: 2, errors: 1 };
  const html = renderToStaticMarkup(createElement(ui.MemoryModelPanel, { value }));
  assert.match(html, /管理员服务级观测：仅当前进程/); assert.match(html, /不是当前账号的调用历史/); assert.match(html, /重启前和其他进程的调用未知/);
});
