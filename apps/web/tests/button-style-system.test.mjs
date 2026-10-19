import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('按钮样式系统提供统一尺寸、字重、语义和无障碍状态', async () => {
  const css = await source('../src/index.css');

  for (const className of [
    'ui-button',
    'ui-button-primary',
    'ui-button-strong',
    'ui-button-secondary',
    'ui-button-danger',
    'ui-button-warning',
    'ui-button-success',
    'ui-button-compact',
    'ui-icon-button',
    'ui-context-action',
    'ui-context-action-accent',
    'ui-context-action-selected',
    'ui-context-action-danger',
  ]) {
    assert.match(css, new RegExp(`\\.${className}\\b`), `缺少 .${className}`);
  }

  assert.match(css, /\.ui-button[\s\S]*h-8[\s\S]*text-xs[\s\S]*font-medium/);
  assert.match(css, /focus-visible:ring-2/);
  assert.match(css, /disabled:cursor-not-allowed/);
});

test('局部上下文操作低强调呈现，并把危险色推迟到悬停状态', async () => {
  const css = await source('../src/index.css');
  const discovery = await source('../src/RequirementDiscoveryWorkbench.tsx');

  assert.match(css, /\.ui-context-action[\s\S]*h-7[\s\S]*border-transparent[\s\S]*text-xs/);
  assert.match(css, /\.ui-context-action-accent[\s\S]*text-cyan-700[\s\S]*hover:bg-cyan-50/);
  assert.match(css, /\.ui-context-action-selected[\s\S]*border-cyan-200[\s\S]*bg-cyan-50/);
  assert.match(css, /\.ui-context-action-danger[\s\S]*text-slate-400[\s\S]*hover:bg-rose-50[\s\S]*hover:text-rose-700/);
  assert.match(discovery, /aria-label=\{t\("关联想法"\)\}[\s\S]*ui-context-action ui-context-action-accent/);
  assert.match(discovery, /aria-label=\{t\("关联文档"\)\}[\s\S]*ui-context-action ui-context-action-accent/);
  assert.match(discovery, /aria-label=\{t\("撤回\{0\}记录", \{ "0": t\(ENTRY_META\[entry\.entry_type\]\.label\) \}\)\}[\s\S]*ui-context-action ui-context-action-danger/);
  assert.match(discovery, /aria-label=\{t\("编辑想法：\{0\}", \{ "0": idea\.title \}\)\}[\s\S]*ui-context-action self-start/);
  assert.match(discovery, /idea\.status === 'active' \? 'ui-button-danger' : 'ui-button-secondary'/);
  assert.doesNotMatch(discovery, /ui-context-action self-start opacity-0/);
  assert.doesNotMatch(discovery, />\+ 关联(?:想法|文档)<\/button>/);
});

test('主要工作台的页面级和弹窗级操作使用语义按钮类', async () => {
  const files = await Promise.all([
    '../src/TeamsWorkspace.tsx',
    '../src/RequirementsWorkbench.tsx',
    '../src/ProjectPlanWorkbench.tsx',
    '../src/DesignWorkbench.tsx',
    '../src/DefectsWorkbench.tsx',
    '../src/ProjectDocumentsWorkbench.tsx',
    '../src/AccountWorkbench.tsx',
  ].map(source));

  const combined = files.join('\n');
  const semanticButtons = combined.match(/ui-button(?:-[a-z]+)?/g) ?? [];

  assert.ok(semanticButtons.length >= 35, `语义按钮迁移不足：${semanticButtons.length}`);
  assert.match(combined, /ui-button ui-button-primary/);
  assert.match(combined, /ui-button ui-button-strong/);
  assert.match(combined, /ui-button ui-button-secondary/);
  assert.match(combined, /ui-button ui-button-danger/);
});

test('筛选弹层和工具栏显式复用控件字号，不再强制覆盖所有后代字体', async () => {
  const app = await source('../src/App.tsx');

  assert.match(app, /aria-label=\{t\("搜索任务"\)\}[^\n]+className="form-control form-control-compact/);
  assert.doesNotMatch(app, /\[&_(?:button|input|legend|h2|h3)\]:!text-/);
  assert.match(app, /className="ui-button ui-button-strong ui-button-block">\{t\("完成"\)\}<\/button>/);
});
