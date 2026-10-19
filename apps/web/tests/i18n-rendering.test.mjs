import { after, before, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
let i18n;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  i18n = await vite.ssrLoadModule('/src/i18n.ts');
});
afterEach(() => i18n.setLocale('zh-CN', false));
after(async () => { await vite?.close(); });
const elements = node => Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : [];

test('all translated UI literals have an English entry and JSX has no untranslated Chinese labels', async () => {
  const root = new URL('../src/', import.meta.url);
  for (const file of (await readdir(root)).filter(file => /\.tsx?$/.test(file))) {
    const source = await readFile(new URL(file, root), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 't' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const key = node.arguments[0].text;
        if (/\p{Script=Han}/u.test(key)) assert.ok(key in i18n.englishMessages, `${file}: missing English message ${key}`);
      }
      if ((ts.isJsxText(node) || ts.isStringLiteralLike(node) && ts.isJsxAttribute(node.parent)) && /\p{Script=Han}/u.test(node.text)) {
        assert.ok(file === 'LanguageSwitcher.tsx' && node.text === '简体中文', `${file}: untranslated UI text ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

test('login switches language while retaining the current account and password drafts', async () => {
  const { LoginPage } = await vite.ssrLoadModule('/src/LoginPage.tsx');
  let stage = 0;
  function Probe() {
    const [, rerender] = useState(0);
    const tree = LoginPage({ onLogin() {} });
    const inputs = elements(tree).filter(node => node.type === 'input');
    if (stage === 0) {
      stage++;
      inputs.find(node => node.props.autoComplete === 'username').props.onChange({ target: { value: 'draft-account' } });
      inputs.find(node => node.props.type === 'password').props.onChange({ target: { value: 'test-only-draft' } });
    } else if (stage === 1) {
      stage++;
      i18n.setLocale('en-US', false);
      rerender(1);
    } else {
      assert.equal(inputs.find(node => node.props.autoComplete === 'username').props.value, 'draft-account');
      assert.equal(inputs.find(node => node.props.type === 'password').props.value, 'test-only-draft');
    }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal(stage, 2);
  assert.match(html, /Sign in/);
  assert.match(html, /aria-label="Language"/);
  assert.match(html, /title="Change language \(English\)"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /用户账号|请输入用户账号/);
});

test('architecture editor retains unsaved source, title and notes across language changes', async () => {
  const { ArchitectureDocumentEditor } = await vite.ssrLoadModule('/src/ArchitectureWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let stage = 0;
  function Probe() {
    const [, rerender] = useState(0);
    const tree = ArchitectureDocumentEditor({ projectCode: 'PROJECT', onClose() {}, onSaved() {} });
    const nodes = elements(tree);
    const source = nodes.find(node => node.type === 'textarea' && node.props['aria-label'] === i18n.t('架构图源'));
    const title = nodes.find(node => node.type === 'input' && node.props.maxLength === 200);
    if (stage === 0) {
      stage++;
      source.props.onChange({ target: { value: 'flowchart LR\n  用户节点-->保存原文' } });
    } else if (stage === 1) {
      stage++;
      title.props.onChange({ target: { value: '未保存的项目架构' } });
    } else if (stage === 2) {
      stage++;
      i18n.setLocale('en-US', false);
      rerender(1);
    } else {
      assert.equal(source.props.value, 'flowchart LR\n  用户节点-->保存原文');
      assert.equal(title.props.value, '未保存的项目架构');
    }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
  assert.equal(stage, 3);
  assert.match(html, /未保存的项目架构/);
  assert.match(html, /用户节点--&gt;保存原文/);
  assert.doesNotMatch(html, /新建架构设计|图源格式|架构名称/);
  client.clear();
});

test('English task cards and document readers retain original names and Markdown content', async () => {
  i18n.setLocale('en-US', false);
  const { TaskCard } = await vite.ssrLoadModule('/src/App.tsx');
  const { ProjectDocumentHeader, MarkdownDocument } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const task = { code: 'TASK-A', title: '任务原文', brief: '用户提供的说明', status: 'closed', profile: 'builder', source: 'requirement', created_at: '2026-10-16T00:00:00Z' };
  const taskHtml = renderToStaticMarkup(createElement(TaskCard, { task, onSelect() {} }));
  assert.match(taskHtml, /View task: 任务原文/);
  assert.match(taskHtml, /Closed/);
  assert.match(taskHtml, /用户提供的说明/);
  const document = { title: '项目规范', summary: '摘要保留原文', kind: 'doc', source_kind: 'project', current_revision: 2, updated_at: '2026-10-16T00:00:00Z', can_edit: true };
  const docHtml = renderToStaticMarkup(createElement('article', null,
    createElement(ProjectDocumentHeader, { document, historical: null, folderLabel: i18n.systemFolderName({ name: '项目规范', system_role: 'standards' }), authorName: '张三', historyOpen: false, onToggleHistory() {}, onReturnCurrent() {}, onEdit() {} }),
    createElement(MarkdownDocument, { content: '# 项目规范\n\n正文 **不要翻译**\n\n- [x] 验收项' })));
  assert.match(docHtml, /Project standards/);
  assert.match(docHtml, /Edit document/);
  assert.match(docHtml, /Version history/);
  assert.match(docHtml, /<strong>不要翻译<\/strong>/);
  assert.match(docHtml, /张三/);
});

test('globe language menu marks the active language and closes after selection', async () => {
  const { default: LanguageSwitcher } = await vite.ssrLoadModule('/src/LanguageSwitcher.tsx');
  let stage = 0;
  function Probe() {
    const tree = LanguageSwitcher({});
    const nodes = elements(tree);
    const trigger = nodes.find(node => node.type === 'button' && node.props['aria-haspopup'] === 'menu');
    if (stage === 0) {
      stage++;
      assert.equal(trigger.props['aria-expanded'], false);
      trigger.props.onClick();
    } else if (stage === 1) {
      stage++;
      const choices = nodes.filter(node => node.props.role === 'menuitemradio');
      assert.equal(choices.length, 2);
      assert.equal(choices[0].props['aria-checked'], true);
      assert.equal(choices[1].props['aria-checked'], false);
      choices[1].props.onClick();
    } else {
      assert.equal(trigger.props['aria-expanded'], false);
      assert.equal(nodes.some(node => node.props.role === 'menu'), false);
    }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal(stage, 2);
  assert.equal(i18n.getLocale(), 'en-US');
  assert.match(html, /aria-label="Language"/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /<select/);
});
