import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { parseWorkspacePath, isWorkspacePath, personalMemoryWorkspacePath, workspacePathAfterLogin } from '../src/workspaceRouting.ts';

let vite, ui, api, i18n, ApiError;
const originalFetch = globalThis.fetch;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [ui, api, i18n, { ApiError }] = await Promise.all(['PersonalMemoryWorkbench.tsx', 'personalMemoryApi.ts', 'i18n.ts', 'apiError.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => { await vite?.close(); });
afterEach(() => { globalThis.fetch = originalFetch; i18n.setLocale('zh-CN', false); });
const elements = node => Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : [];
const memory = (changes = {}) => ({
  source: 'MEMORY-A', revisionSource: 'REVISION-2', revision: 2, text: '我偏好先说明原因，再给出实现。', status: 'active',
  applicability: 'project', projectCode: 'PROJECT-A', projectName: '开发协作项目', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T01:00:00Z',
  provenance: { receiptCode: 'RECEIPT-A', sessionId: 'my-session', eventId: 'turn-8' },
  projection: { status: 'synced', operation: 'upsert', generation: 1, cleanupPending: false },
  history: [{ source: 'REVISION-2', revision: 2, text: '我偏好先说明原因，再给出实现。', status: 'active', reason: '纠正说明顺序', createdAt: '2026-11-11T01:00:00Z' }],
  ...changes,
});

function renderWorkbench(owner, value, options = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  if (value) {
    client.setQueryData(api.personalMemoryListKey(owner, 'active', options.project), { items: [value], truncated: false });
    client.setQueryData(api.personalMemoryDetailKey(owner, value.source), value);
  } else if (options.empty) client.setQueryData(api.personalMemoryListKey(owner, 'active'), { items: [], truncated: false });
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ui.PersonalMemoryWorkbench, { ownerCode: options.renderOwner ?? owner, initialProject: options.project }))); }
  finally { client.clear(); }
}

test('personal memory has its own signed-in route and is not restricted to project or admin navigation', async () => {
  assert.equal(isWorkspacePath('/account/memory'), true);
  assert.equal(isWorkspacePath('/account/memory/extra'), false);
  assert.deepEqual(parseWorkspacePath('/account/memory'), { view: 'personal-memory' });
  assert.deepEqual(parseWorkspacePath('/account/memory?project=PROJECT-A'), { view: 'personal-memory', personalMemoryProject: 'PROJECT-A' });
  assert.equal(personalMemoryWorkspacePath('项目/A'), '/account/memory?project=%E9%A1%B9%E7%9B%AE%2FA');
  for (const admin of [false, true]) assert.equal(workspacePathAfterLogin('http://localhost/account/memory', admin), '/account/memory');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /view === 'personal-memory'[\s\S]*?<PersonalMemoryWorkbench key=\{`\$\{session.code\}/);
  assert.match(app, /ownerCode=\{session.code\}/);
});

test('details keep ownership and applicability distinct and expose source, revisions and cleanup truth', () => {
  const value = memory({ projection: { status: 'needs_reconcile', operation: 'upsert', generation: 2, cleanupPending: true, lastError: 'mapping_missing' } });
  const html = renderWorkbench('ALICE', value);
  assert.match(html, /仅本人可见/);
  assert.match(html, /仅当前项目/);
  assert.match(html, /PROJECT-A/);
  assert.match(html, /来源项目|开发协作项目/);
  assert.match(html, /来源会话|my-session/);
  assert.match(html, /turn-8/);
  assert.match(html, /REVISION-2/);
  assert.match(html, /修订历史|纠正说明顺序/);
  assert.match(html, /同步待恢复|mapping_missing/);
  assert.match(html, /旧版本已停用，存储副本仍在清理/);
  assert.doesNotMatch(html, /团队共享|Tencent|API Key/);
});

test('private caches are owner-scoped and empty/loading states remain usable', () => {
  assert.doesNotMatch(renderWorkbench('ALICE', memory(), { renderOwner: 'BOB' }), /我偏好先说明原因/);
  assert.match(renderWorkbench('ALICE', null), /正在读取个人记忆/);
  assert.match(renderWorkbench('ALICE', null, { empty: true }), /这里还没有记忆/);
  const html = renderToStaticMarkup(createElement(ui.PersonalMemoryDetails, {
    value: memory({ status: 'withdrawn', projection: { status: 'synced', operation: 'delete', generation: 3, cleanupPending: false } }), onEdit() {}, onWithdraw() {},
  }));
  assert.match(html, /这条记忆已停用/);
  assert.match(html, /编辑并恢复/);
  assert.doesNotMatch(html, />撤回<|共享检索可用/);
});

test('editor preserves its draft across a newer revision and only adopts the new witness after explicit review', () => {
  let value = memory(), stage = 0;
  function Probe() {
    const [, rerender] = useState(0);
    const tree = ui.PersonalMemoryEditor({ value, onSave: async () => {}, onCancel() {}, onRefresh: async () => {} });
    const nodes = elements(tree);
    const content = nodes.find(node => node.type === 'textarea');
    if (stage === 0) { stage++; content.props.onChange({ target: { value: '保留我的未保存草稿' } }); }
    else if (stage === 1) { stage++; value = memory({ revision: 3, revisionSource: 'REVISION-3', text: '另一会话的新内容' }); rerender(1); }
    else if (stage === 2) {
      stage++;
      assert.equal(content.props.value, '保留我的未保存草稿');
      assert.equal(nodes.find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
      nodes.find(node => node.type === 'button' && node.props.children === '已核对，以当前版本继续保存草稿').props.onClick();
    } else {
      assert.equal(content.props.value, '保留我的未保存草稿');
      assert.equal(nodes.find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, false);
    }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal(stage, 3);
  assert.match(html, /保留我的未保存草稿/);
});

test('editor submission preserves expected revision and scope; duplicate submit sends only once', async () => {
  const calls = [];
  function Probe() {
    const tree = ui.PersonalMemoryEditor({ value: memory(), onSave: async input => { calls.push(input); }, onCancel() {}, onRefresh: async () => {} });
    const nodes = elements(tree);
    const content = nodes.find(node => node.type === 'textarea');
    if (content.props.value !== '我的新草稿') content.props.onChange({ target: { value: '我的新草稿' } });
    else if (!calls.length) { tree.props.onSubmit({ preventDefault() {} }); tree.props.onSubmit({ preventDefault() {} }); }
    return tree;
  }
  renderToStaticMarkup(createElement(Probe));
  await Promise.resolve();
  assert.deepEqual(calls, [{ expectedRevision: 2, text: '我的新草稿' }]);
});

test('withdrawal freezes the version shown at confirmation and refuses a concurrent update', () => {
  let value = memory(), stage = 0, calls = 0;
  function Probe() {
    const [, rerender] = useState(0);
    const tree = ui.PersonalMemoryWithdrawal({ value, onWithdraw: async () => { calls++; }, onCancel() {} });
    if (!stage) { stage++; value = memory({ revision: 3 }); rerender(1); }
    else {
      tree.props.onSubmit({ preventDefault() {} });
      assert.equal(elements(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
    }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal(calls, 0);
  assert.match(html, /撤回尚未执行/);
});

test('API uses stable management IDs and optimistic revisions, with no owner or scope override', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.method ?? 'GET', init.body ? JSON.parse(init.body) : undefined]);
    return new Response(JSON.stringify({ ok: true, data: String(url).includes('?') ? { items: [memory()], truncated: false } : memory() }));
  };
  await api.listPersonalMemory('all', 'PROJECT-A');
  await api.getPersonalMemory('MEMORY-A');
  await api.editPersonalMemory('MEMORY-A', { expectedRevision: 2, text: '更新后的偏好', reason: '纠正' });
  await api.withdrawPersonalMemory('MEMORY-A', { expectedRevision: 2, reason: '不再适用' });
  assert.deepEqual(calls, [
    ['/api/memory/personal?status=all&projectCode=PROJECT-A', 'GET', undefined],
    ['/api/memory/personal/MEMORY-A', 'GET', undefined],
    ['/api/memory/personal/MEMORY-A', 'PATCH', { expectedRevision: 2, text: '更新后的偏好', reason: '纠正' }],
    ['/api/memory/personal/MEMORY-A/withdraw', 'POST', { expectedRevision: 2, reason: '不再适用' }],
  ]);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'memory_revision_conflict', message: '版本已变化' } }), { status: 409 });
  await assert.rejects(api.editPersonalMemory('MEMORY-A', { expectedRevision: 2, text: '草稿' }), error => api.personalMemoryConflict(error));
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: memory({ source: 'SOMEONE-ELSE' }) }));
  await assert.rejects(api.getPersonalMemory('MEMORY-A'), error => error instanceof ApiError && error.code === 'memory_source_mismatch');
});

for (const kind of ['edit','withdraw']) {
  test(`${kind} pins the original memory when background list refresh changes the first row`, () => {
    const owner='PINNED-'+kind, a=memory({source:'MEMORY-A'}), b=memory({source:'MEMORY-B',text:'另一条记忆'});
    const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
    client.setQueryData(api.personalMemoryListKey(owner,'active'),{items:[a,b],truncated:false});
    for(const item of [a,b])client.setQueryData(api.personalMemoryDetailKey(owner,item.source),item);
    let stage=0;
    function Probe(){
      const [,rerender]=useState(0);
      const tree=ui.PersonalMemoryWorkbench({ownerCode:owner});
      const nodes=elements(tree);
      if(stage===0){stage++;const details=nodes.find(node=>node.type===ui.PersonalMemoryDetails);details.props[kind==='edit'?'onEdit':'onWithdraw']();}
      else if(stage===1){stage++;client.setQueryData(api.personalMemoryListKey(owner,'active'),{items:[b,a],truncated:false});rerender(1);}
      else {const editor=nodes.find(node=>node.type===(kind==='edit'?ui.PersonalMemoryEditor:ui.PersonalMemoryWithdrawal));assert.equal(editor.props.value.source,'MEMORY-A');}
      return tree;
    }
    try {renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(Probe)));assert.equal(stage,2);}
    finally {client.clear();}
  });
}

for (const kind of ['edit','withdraw']) {
  test(`${kind} refuses a different memory with the same revision number`, () => {
    let value=memory(), stage=0, calls=0;
    function Probe(){
      const [,rerender]=useState(0);
      const tree=kind==='edit'?ui.PersonalMemoryEditor({value,onSave:async()=>{calls++;},onCancel(){},onRefresh:async()=>{}})
        :ui.PersonalMemoryWithdrawal({value,onWithdraw:async()=>{calls++;},onCancel(){}});
      if(!stage){stage++;value=memory({source:'MEMORY-B'});rerender(1);}
      else {tree.props.onSubmit({preventDefault(){}});assert.equal(elements(tree).find(node=>node.type==='button'&&node.props.type==='submit').props.disabled,true);}
      return tree;
    }
    renderToStaticMarkup(createElement(Probe));
    assert.equal(calls,0);
  });
}

test('English personal memory renders translated chrome and preserves user-provided text', () => {
  i18n.setLocale('en-US', false);
  const html = renderWorkbench('ALICE', memory());
  assert.match(html, /My memory|Only visible to me|This project only/);
  assert.match(html, /我偏好先说明原因/);
  assert.doesNotMatch(html, /记忆详情|修订历史|仅本人可见/);
});
