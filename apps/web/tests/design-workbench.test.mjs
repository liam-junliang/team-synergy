import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

test('HTML 原型预览注入隔离策略并保留内联交互', async () => {
  const { prototypePreviewDocument } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  const rendered = prototypePreviewDocument('<html><head><title>Demo</title></head><body><button onclick="ok()">确认</button></body></html>');
  assert.match(rendered, /Content-Security-Policy/);
  assert.match(rendered, /connect-src 'none'/);
  assert.match(rendered, /form-action 'none'/);
  assert.match(rendered, /onclick="ok\(\)"/);
});

test('图片原型转换为可离线分发的自包含 HTML', async () => {
  const { createImagePrototypeHtml, imagePrototypeFromHtml } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  const image = 'data:image/png;base64,aGVsbG8=';
  const html = createImagePrototypeHtml(image, '登录页「默认」状态');
  assert.match(html, /acp-prototype-kind/);
  assert.match(html, /data:image\/png;base64,aGVsbG8=/);
  assert.deepEqual(imagePrototypeFromHtml(html), { dataUrl: image, alt: '登录页「默认」状态' });
});

test('英文设计编辑器本地化控件，同时保留已有名称、HTML 图源及需求标题', async () => {
  const { PrototypeEditorDialog, designUploadError, imagePrototypeFromHtml, createImagePrototypeHtml } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  const { setLocale } = await vite.ssrLoadModule('/src/i18n.ts');
  const initial = { title: '客户自定义方案', summary: '中文设计范围', html_content: '<button>用户原始图源</button>', notes_markdown: '# 用户原始说明', status: 'ready', content_kind: 'html', linked_requirements: [], current_revision: 2 };
  try {
    setLocale('en-US', false);
    const html = renderToStaticMarkup(createElement(PrototypeEditorDialog, { mode: 'edit', initial, requirements: [], pending: false, error: null, onClose() {}, onSubmit() {} }));
    assert.match(html, /Design title/);
    assert.match(html, /Interactive HTML/);
    assert.match(html, /Save as new revision/);
    assert.match(html, /客户自定义方案/);
    assert.match(html, /中文设计范围/);
    assert.match(html, /&lt;button&gt;用户原始图源&lt;\/button&gt;/);
    assert.equal(designUploadError('image', { type: 'image/png', size: 5 * 1024 * 1024 }), 'Image must not exceed 4 MiB');
    const source = createImagePrototypeHtml('data:image/png;base64,YQ==', '中文图片说明');
    assert.match(source, /lang="en-US"/);
    assert.equal(imagePrototypeFromHtml(source).alt, '中文图片说明');
  } finally {
    setLocale('zh-CN', false);
  }
});

test('默认原型直接呈现系统界面，业务与代码说明保存在独立 Markdown 中', async () => {
  const { DEFAULT_DESIGN_NOTES, DEFAULT_VISUAL_PROTOTYPE_HTML } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  assert.match(DEFAULT_VISUAL_PROTOTYPE_HTML, /data-screen="tasks"/);
  assert.match(DEFAULT_VISUAL_PROTOTYPE_HTML, /showScreen\('tasks'\)/);
  assert.match(DEFAULT_VISUAL_PROTOTYPE_HTML, /任务看板/);
  assert.match(DEFAULT_VISUAL_PROTOTYPE_HTML, /视觉原型/);
  assert.doesNotMatch(DEFAULT_VISUAL_PROTOTYPE_HTML, /把需求变成/);
  assert.doesNotMatch(DEFAULT_VISUAL_PROTOTYPE_HTML, /用户目标/);
  assert.match(DEFAULT_DESIGN_NOTES, /业务逻辑/);
  assert.match(DEFAULT_DESIGN_NOTES, /数据逻辑/);
  assert.match(DEFAULT_DESIGN_NOTES, /代码实现提示/);
  assert.match(DEFAULT_DESIGN_NOTES, /注意事项/);
});

test('开发代理转发 /api 请求并剥离前缀，项目页面路径不会命中 API 代理', () => {
  const proxies = vite.config.server.proxy;
  const proxyFor = (path) => Object.entries(proxies).find(([key]) => key.startsWith('^') ? new RegExp(key).test(path) : path.startsWith(key))?.[1];
  const apiProxy = proxyFor('/api/projects/PROJECT-A');
  assert.ok(apiProxy);
  assert.equal(apiProxy.rewrite('/api/projects/PROJECT-A'), '/projects/PROJECT-A');
  assert.equal(proxyFor('/api/design-prototypes/PROTO-A/file?revision=3').rewrite('/api/design-prototypes/PROTO-A/file?revision=3'), '/design-prototypes/PROTO-A/file?revision=3');
  assert.equal(proxyFor('/projects/PROJECT-A'), undefined);
  assert.equal(proxyFor('/design-prototypes/PROTO-A'), undefined);
  assert.equal(proxyFor('/apiary'), undefined);
});

test('设计工作台展示设计方案、交互预览、关联元数据与版本记录', async () => {
  const { DesignWorkbench } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  const queryClient = new QueryClient();
  const requirement = { code: 'REQ-DESIGN', title: '需求完成后可产出 HTML 原型', status: 'confirmed' };
  const summary = {
    code: 'PROTO-DESIGN',
    project_code: 'PROJECT-A',
    title: '需求到开发体验原型',
    summary: '验证核心路径。',
    status: 'ready',
    current_revision: 2,
    owner_principal_code: 'USER-A',
    linked_requirements: [{
      requirement_code: requirement.code,
      title: requirement.title,
      status: 'confirmed',
      feature_code: 'FEATURE-A',
      feature_name: '设计工作台',
    }],
    updated_at: '2026-08-18T08:00:00.000Z',
  };
  const detail = {
    ...summary,
    html_content: '<!doctype html><html><body><button>开始</button></body></html>',
    notes_markdown: '# 业务逻辑\n\n- 点击开始后进入工作台。',
    change_summary: '补齐主流程',
    can_edit: true,
    revisions: [
      { code: 'REV-2', revision: 2, change_summary: '补齐主流程', has_notes: true, created_by: 'USER-A', created_at: '2026-08-18T08:00:00.000Z' },
      { code: 'REV-1', revision: 1, change_summary: '初始原型', has_notes: false, created_by: 'USER-A', created_at: '2026-08-17T08:00:00.000Z' },
    ],
  };
  queryClient.setQueryData(['project', 'PROJECT-A'], { code: 'PROJECT-A', role: 'owner', status: 'active' });
  queryClient.setQueryData(['design-prototypes', 'PROJECT-A'], [summary]);
  queryClient.setQueryData(['design-prototype', 'PROTO-DESIGN'], detail);
  queryClient.setQueryData(['requirements', 'PROJECT-A'], [requirement]);

  const markup = renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(DesignWorkbench, { projectCode: 'PROJECT-A' }),
  ));

  assert.match(markup, /设计方案/);
  assert.match(markup, /Interactive preview/i);
  assert.match(markup, /配套说明/);
  assert.match(markup, /关联需求/);
  assert.match(markup, /版本记录/);
  assert.match(markup, /HTML、图片、URL 链接和特殊文件/);
  assert.match(markup, /需求完成后可产出 HTML 原型/);
  assert.match(markup, /sandbox="allow-scripts"/);
  assert.match(markup, /Content-Security-Policy/);
  assert.match(markup, /编辑并创建新版本/);
  assert.match(markup, /适应画布/);
  assert.match(markup, /自定义尺寸/);
  assert.match(markup, /aria-label="预览宽高"/);
  queryClient.setQueryData(['project', 'PROJECT-A'], { code: 'PROJECT-A', role: 'viewer', status: 'active' });
  const viewer = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(DesignWorkbench, { projectCode: 'PROJECT-A' })));
  assert.doesNotMatch(viewer, /编辑并创建新版本|>添加设计资料</);
  assert.match(viewer, /Interactive preview/i);
  queryClient.setQueryData(['design-prototypes', 'PROJECT-A'], []);
  const emptyViewer = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(DesignWorkbench, { projectCode: 'PROJECT-A' })));
  assert.doesNotMatch(emptyViewer, /<button[^>]*>添加设计资料<\/button>/);
  queryClient.clear();
});

test('配套说明使用浅色协作文档编辑器', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/DesignWorkbench.tsx', import.meta.url)), 'utf8');
  const notesPanel = source.slice(source.indexOf('function DesignNotesPanel'), source.indexOf('function EmptyDesignState'));
  assert.match(notesPanel, /bg-white/);
  assert.match(notesPanel, /font-sans text-sm leading-6/);
  assert.doesNotMatch(notesPanel, /bg-slate-950/);
});

test('URL 校验仅接受不含登录凭据的 HTTP(S)，保留定位参数', async () => {
  const { designExternalUrl } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  assert.equal(designExternalUrl(' https://example.com/design?node=42#screen '), 'https://example.com/design?node=42#screen');
  assert.equal(designExternalUrl('http://localhost:3000/prototype'), 'http://localhost:3000/prototype');
  for (const value of ['javascript:alert(1)', 'data:text/html,<script></script>', 'file:///tmp/design.html', '//example.com', 'https://user:secret@example.com', 'not a url']) {
    assert.equal(designExternalUrl(value), null, value);
  }
});

test('文件上传允许任意格式并限制 20 MiB，图片和 HTML 保持单独上限', async () => {
  const { designUploadError } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  assert.equal(designUploadError('file', { type: '', size: 20 * 1024 * 1024 }), null);
  assert.equal(designUploadError('file', { type: 'application/octet-stream', size: 0 }), null);
  assert.match(designUploadError('file', { type: '', size: 20 * 1024 * 1024 + 1 }), /20 MiB/);
  assert.match(designUploadError('image', { type: 'image/svg+xml', size: 20 }), /PNG/);
  assert.match(designUploadError('image', { type: 'image/png', size: 4 * 1024 * 1024 + 1 }), /4 MiB/);
  assert.match(designUploadError('html', { type: 'text/html', size: 6 * 1024 * 1024 + 1 }), /6 MiB/);
});

const fileDetail = {
  code: 'PROTO-FILE', title: '设计源文件', summary: '交付源文件', status: 'ready', current_revision: 2,
  content_kind: 'file', html_content: '', external_url: null, file_name: '界面源文件.fig',
  file_mime_type: 'application/octet-stream', file_size: 2048, file_sha256: 'abc',
  download_path: 'https://untrusted.example/never-use-this-path',
  notes_markdown: '# 使用说明', linked_requirements: [{ requirement_code: 'REQ-A' }],
  revisions: [], can_edit: true,
};

test('说明修订保留原文件和 URL，不重新上传文件；旧图片仍按图片编辑', async () => {
  const { designNotesRevision, designContentKind, createImagePrototypeHtml } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  const input = designNotesRevision(fileDetail, '# 新说明');
  assert.equal(input.content_kind, 'file');
  assert.equal(input.file_name, '界面源文件.fig');
  assert.equal(input.file_mime_type, 'application/octet-stream');
  assert.equal(input.html_content, '');
  assert.equal(input.notes_markdown, '# 新说明');
  assert.deepEqual(input.requirement_codes, ['REQ-A']);
  assert.equal(Object.hasOwn(input, 'file_content_base64'), false);
  const urlInput = designNotesRevision({ ...fileDetail, content_kind: 'url', external_url: 'https://example.com/#42' }, '链接说明');
  assert.equal(urlInput.content_kind, 'url');
  assert.equal(urlInput.external_url, 'https://example.com/#42');
  const html = createImagePrototypeHtml('data:image/png;base64,aGVsbG8=', '图片');
  assert.equal(designContentKind({ html_content: html }), 'image');
  assert.equal(designContentKind({ html_content: html, content_kind: 'html' }), 'image');
});

test('链接默认仅展示原站入口，特殊文件仅展示元数据和下载入口', async () => {
  const { DesignContentPreview } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  const urlMarkup = renderToStaticMarkup(createElement(DesignContentPreview, {
    detail: { ...fileDetail, content_kind: 'url', external_url: 'https://example.com/design?node=42' }, height: 600,
  }));
  assert.match(urlMarkup, /href="https:\/\/example.com\/design\?node=42"/);
  assert.match(urlMarkup, /rel="noopener noreferrer"/);
  assert.match(urlMarkup, /尝试网页预览/);
  assert.doesNotMatch(urlMarkup, /<iframe/);
  const fileMarkup = renderToStaticMarkup(createElement(DesignContentPreview, { detail: fileDetail, height: 600 }));
  assert.match(fileMarkup, /界面源文件.fig/);
  assert.match(fileMarkup, /2.0 KiB/);
  assert.match(fileMarkup, /下载文件/);
  assert.doesNotMatch(fileMarkup, /<iframe|untrusted.example/);
});

test('编辑既有文件提供四种资料类型并明确保留当前文件', async () => {
  const { PrototypeEditorDialog } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  const markup = renderToStaticMarkup(createElement(PrototypeEditorDialog, {
    mode: 'edit', initial: fileDetail, requirements: [], pending: false, error: null, onClose() {}, onSubmit() {},
  }));
  for (const label of ['交互 HTML', '界面图片', 'URL 链接', '特殊文件', '界面源文件.fig', '保留当前文件', '20 MiB']) assert.match(markup, new RegExp(label));
  assert.match(markup, /role="group" aria-label="设计资料类型"/);
  assert.equal((markup.match(/class="ui-segmented-item"/g) ?? []).length, 4);
  assert.match(markup, /aria-pressed="true" class="ui-segmented-item">特殊文件/);
  assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /视觉原型源码/);
});

test('API 归一化保留各版本内容类型和文件元数据，兼容旧图片响应', async (t) => {
  const { getDesignPrototype } = await vite.ssrLoadModule('/src/api.ts');
  const { createImagePrototypeHtml } = await vite.ssrLoadModule('/src/DesignWorkbench.tsx');
  let response = { ...fileDetail, revisions: [{ ...fileDetail, revision_code: 'REV-FILE', revision: 1, created_at: '', created_by: 'USER-A' }] };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, data: response }), { status: 200 }));
  const detail = await getDesignPrototype('PROTO-FILE');
  assert.equal(detail.file_size, 2048);
  assert.equal(detail.file_sha256, 'abc');
  assert.equal(detail.revisions[0].content_kind, 'file');
  assert.equal(detail.revisions[0].file_name, '界面源文件.fig');
  response = { prototype_code: 'PROTO-OLD', html_content: createImagePrototypeHtml('data:image/png;base64,aGVsbG8=', '旧图片') };
  const legacy = await getDesignPrototype('PROTO-OLD');
  assert.equal(legacy.content_kind, 'image');
  assert.equal(legacy.external_url, null);
  assert.equal(legacy.file_name, null);
});

test('文件下载构造本地版本路径并禁止携带凭据跟随重定向，失败时显示服务端错误', async (t) => {
  const { getDesignPrototypeFile } = await vite.ssrLoadModule('/src/api.ts');
  const previousWindow = globalThis.window;
  globalThis.window = { location: new URL('https://workspace.test/projects/PROJECT-A/design/PROTO-A'), localStorage: { getItem: (key) => key === 'acp.device_token' ? 'test-token' : null } };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => { calls.push({ path, init }); return new Response(new Uint8Array([0, 1, 255])); });
  const blob = await getDesignPrototypeFile('https://other.example/file?token=x', 3);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 255]);
  assert.equal(calls[0].path, '/api/design-prototypes/https%3A%2F%2Fother.example%2Ffile%3Ftoken%3Dx/file?revision=3');
  assert.equal(new URL(calls[0].path, globalThis.window.location.href).href, 'https://workspace.test/api/design-prototypes/https%3A%2F%2Fother.example%2Ffile%3Ftoken%3Dx/file?revision=3');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer test-token');
  assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(getDesignPrototypeFile('PROTO-FILE', NaN), /版本无效/);
  assert.equal(calls.length, 1);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: '无权下载该文件' } }), { status: 403 }));
  await assert.rejects(getDesignPrototypeFile('PROTO-FILE', 1), /无权下载该文件/);
});
