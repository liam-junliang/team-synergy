import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let i18n;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  i18n = await vite.ssrLoadModule('/src/i18n.ts');
});
afterEach(() => i18n.setLocale('zh-CN', false));
after(async () => { await vite?.close(); });

test('English sign-in and first-login screens include a language picker without translating the account', async () => {
  const { LoginPage } = await vite.ssrLoadModule('/src/LoginPage.tsx');
  const { PasswordChangePage } = await vite.ssrLoadModule('/src/PasswordChangePage.tsx');
  i18n.setLocale('en-US', false);
  const login = renderToStaticMarkup(createElement(LoginPage, { onLogin() {} }));
  assert.match(login, /Sign in to your workspace/);
  assert.match(login, /Enter your username/);
  assert.match(login, /aria-label="Language"/);
  assert.match(login, /aria-haspopup="menu" aria-expanded="false"/);
  assert.match(login, /title="Change language \(English\)"/);
  assert.match(login, /<ellipse cx="12" cy="12" rx="4" ry="9"/);
  assert.doesNotMatch(login, /<select/);
  assert.doesNotMatch(login, /登录项目工作台|请输入用户账号/);
  const password = renderToStaticMarkup(createElement(PasswordChangePage, { user: { account: '中文账号' }, onChanged() {}, onLogout() {} }));
  assert.match(password, /Set a new password/);
  assert.match(password, /中文账号/);
  assert.match(password, /8 to 128 characters/);
  assert.match(password, /Save password and continue/);
  i18n.setLocale('zh-CN', false);
  assert.match(renderToStaticMarkup(createElement(LoginPage, { onLogin() {} })), /登录项目工作台/);
});

test('architecture starters follow the creation language while existing source and notes remain untouched', async () => {
  const { architectureDraft, architectureTemplate, updateArchitectureSource } = await vite.ssrLoadModule('/src/architectureDocuments.ts');
  i18n.setLocale('en-US', false);
  const draft = architectureDraft();
  assert.match(draft.source_content, /Application service/);
  assert.match(architectureTemplate('drawio'), /name="System architecture"/);
  const existing = { title: '原始架构', content_kind: 'mermaid', source_content: 'graph LR\nA[应用服务]-->B[数据库]', notes_markdown: '# 中文说明', preview_svg: null };
  assert.equal(architectureDraft(existing).source_content, existing.source_content);
  assert.equal(architectureDraft(existing).notes_markdown, existing.notes_markdown);
  i18n.setLocale('zh-CN', false);
  assert.match(architectureDraft().source_content, /应用服务/);
  assert.match(draft.source_content, /Application service/, 'changing locale does not rewrite an existing draft');
  assert.equal(updateArchitectureSource(draft, draft.source_content).source_content, draft.source_content);
});

test('architecture reader translates controls while keeping user titles, notes, and source intact', async () => {
  const { ArchitectureDocumentHeader, ArchitecturePreview } = await vite.ssrLoadModule('/src/ArchitectureWorkbench.tsx');
  i18n.setLocale('en-US', false);
  const document = { title: '系统原始名称', summary: '用户摘要', content_kind: 'image', source_content: 'data:image/png;base64,iVBORw0KGgo=', document_code: 'ARCH-1', current_revision: 1, updated_at: '2026-10-16T00:00:00Z', can_edit: true };
  const html = renderToStaticMarkup(createElement(ArchitectureDocumentHeader, { document, historyOpen: false, onToggleHistory() {}, onReturnCurrent() {}, onEdit() {}, onDownload() {} }));
  assert.match(html, /Download source/);
  assert.match(html, /Edit current revision/);
  assert.match(html, /Version history/);
  assert.match(html, /系统原始名称/);
  assert.match(html, /用户摘要/);
  assert.doesNotMatch(html, /下载图源|编辑当前版本|架构图片/);
  const preview = renderToStaticMarkup(createElement(ArchitecturePreview, { document }));
  assert.match(preview, /alt="系统原始名称"/);
  assert.match(preview, /data:image\/png;base64,iVBORw0KGgo=/);
});

test('Markdown localizes generated accessibility labels without translating document text or anchors', async () => {
  const { MarkdownDocument } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const content = '# 中文标题\n\n| 名称 | 内容 |\n| --- | --- |\n| 项目 | 规范 |\n\n正文[^1]\n\n[^1]: 中文脚注';
  i18n.setLocale('en-US', false);
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { content }));
  assert.match(html, /id="中文标题"/);
  assert.match(html, /aria-label="Table"/);
  assert.match(html, /Footnotes/);
  assert.match(html, /Back to content/);
  assert.match(html, /中文脚注/);
  assert.doesNotMatch(html, /aria-label="表格"/);
});

test('draw.io language is chosen when opening a session and does not alter diagram messages', async () => {
  const { drawioFrameUrl, createDrawioSession } = await vite.ssrLoadModule('/src/drawioProtocol.ts');
  i18n.setLocale('en-US', false);
  const openedUrl = drawioFrameUrl(false);
  assert.equal(new URL(openedUrl).searchParams.get('lang'), 'en');
  const source = '<mxGraphModel><root><mxCell id="0" value="用户内容"/></root></mxGraphModel>';
  const sent = [];
  const session = createDrawioSession({ source, readOnly: false, send: value => sent.push(value), onLoaded() {}, onError() {}, onExporting() {}, onSave() {}, onExit() {} });
  i18n.setLocale('zh-CN', false);
  session.receive({ event: 'init' });
  assert.equal(sent[0].xml, source);
  assert.equal(new URL(openedUrl).searchParams.get('lang'), 'en');
  assert.equal(new URL(drawioFrameUrl(false)).searchParams.get('lang'), 'zh');
  session.dispose();
});
