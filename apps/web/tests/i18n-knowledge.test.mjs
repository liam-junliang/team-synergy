import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { englishMessages, setLocale, t } from '../src/i18n.ts';

test('需求、设计和文档界面文案及默认 Markdown 模板具有英文翻译', () => {
  const files = ['RequirementsWorkbench.tsx', 'RequirementDiscoveryWorkbench.tsx', 'DesignWorkbench.tsx', 'ProjectDocumentsWorkbench.tsx', 'DocumentVersionHistory.tsx'];
  const missing = new Set();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      // The complete visual-prototype HTML is editable sample content, not interface copy.
      if (ts.isStringLiteralLike(node) && /\p{Script=Han}/u.test(node.text) && node.text.length < 500) {
        if (!englishMessages[node.text]) missing.add(`${file}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual([...missing], []);
});

test('动态数量和资料名称插值保留用户内容并随语言切换', () => {
  try {
    setLocale('en-US', false);
    assert.equal(t('已关联 {0} 个任务', { 0: 1234 }), '1,234 linked tasks');
    assert.equal(t('编辑 {0}', { 0: '用户定义需求 {0}' }), 'Edit 用户定义需求 {0}');
    setLocale('zh-CN', false);
    assert.equal(t('编辑 {0}', { 0: 'User requirement' }), '编辑 User requirement');
  } finally {
    setLocale('zh-CN', false);
  }
});
