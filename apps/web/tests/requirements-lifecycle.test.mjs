import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workbench = readFileSync(new URL('../src/RequirementsWorkbench.tsx', import.meta.url), 'utf8');
const discovery = readFileSync(new URL('../src/RequirementDiscoveryWorkbench.tsx', import.meta.url), 'utf8');
const formSelect = readFileSync(new URL('../src/FormSelect.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('需求工作台按发现到需求清单的顺序呈现，模块管理由项目工作台承载', () => {
  const labels = ['想法', '需求议题', '需求文档', '需求清单'];
  let cursor = -1;
  for (const label of labels) {
    const next = workbench.indexOf(`>{t("${label}")}`);
    assert.ok(next > cursor, `${label} 应按生命周期顺序出现`);
    cursor = next;
  }
  assert.doesNotMatch(workbench, /需求点|需求表/);
  assert.doesNotMatch(workbench, /在右侧管理模块与 Feature/);
  assert.doesNotMatch(workbench, /ProjectStructureWorkbench|tab: 'structure'/);
  assert.match(workbench, /RequirementReviewPanel/);
});

test('想法卡片进入编辑弹窗，归档与恢复操作收敛在编辑窗口', () => {
  assert.match(discovery, /setIdeaDialog\(\{ mode: 'edit', idea \}\)/);
  assert.match(discovery, /aria-label=\{t\("编辑想法：\{0\}", \{ "0": idea\.title \}\)\}/);
  assert.match(discovery, /title=\{idea \? t\("编辑想法"\) : t\("记录想法"\)\}/);
  assert.match(discovery, /useState\(idea\?\.title \?\? ''\)/);
  assert.match(discovery, /useState\(idea\?\.detail \?\? ''\)/);
  assert.match(discovery, /useState\(idea\?\.source \?\? ''\)/);
  assert.match(discovery, /idea\.status === 'active' \? t\("归档想法"\) : t\("恢复想法"\)/);
  assert.match(discovery, /<footer className="flex items-center justify-between gap-3 border-t border-slate-200/);
  assert.doesNotMatch(discovery, /aria-label=\{`\$\{idea\.status === 'active' \? '归档' : '恢复'\}想法/);
});

test('想法工具栏保持搜索与操作分区稳定，并统一控件高度和搜索字号', () => {
  assert.match(discovery, /w-\[360px\][\s\S]*<SearchIcon \/>[\s\S]*text-\[13px\]/);
  assert.match(discovery, /disabled=\{selected\.size === 0\}[\s\S]*>\{t\("整理为议题"\)/);
  assert.match(discovery, /className="ui-button ui-button-secondary">\{t\("整理为议题"\)/);
  assert.match(discovery, /className="ui-button ui-button-primary">\{t\("记录想法"\)/);
  assert.doesNotMatch(discovery, /selected\.size > 0 && <button[^>]*>整理为议题/);
});

test('需求文档从项目功能模块中选择归属，不再手填模块标识', () => {
  assert.match(workbench, /listProjectModules/);
  assert.match(workbench, /queryKey: \['project-modules', activeProjectCode\]/);
  assert.match(workbench, /<FormSelect[\s\S]*required[\s\S]*value=\{moduleCode\}/);
  assert.match(workbench, /placeholder=\{t\("请选择功能模块"\)\}/);
  assert.match(workbench, /meta: module\.status === 'archived' \? t\("已归档"\)/);
  assert.match(workbench, /module_code: selectedModule\.code/);
  assert.match(workbench, /module_key: selectedModule\.name/);
  assert.doesNotMatch(workbench, /Field label="模块标识"/);
  assert.doesNotMatch(workbench, /来自项目功能模块；如需新增/);
  assert.doesNotMatch(workbench, /推断模块与标题/);
});

test('原生下拉框沿用统一表单样式并提供清晰的交互状态', () => {
  assert.match(styles, /@import "tailwindcss"/);
  assert.doesNotMatch(styles, /button,\s*input,\s*select,\s*textarea\s*\{\s*font: inherit;/);
  assert.match(styles, /select\.form-control\s*\{/);
  assert.match(styles, /appearance-none/);
  assert.match(styles, /hover:border-slate-400/);
  assert.match(styles, /background-image: url\("data:image\/svg\+xml/);
  assert.match(styles, /background-position: right 0\.875rem center/);
  assert.match(styles, /disabled:cursor-not-allowed/);
});

test('需求文档模块选择器自定义展开选项、选中态和键盘操作', () => {
  assert.match(formSelect, /role="combobox"/);
  assert.match(formSelect, /role="listbox"/);
  assert.match(formSelect, /role="option"/);
  assert.match(formSelect, /bg-cyan-50 font-semibold text-cyan-900/);
  assert.match(formSelect, /shadow-xl shadow-slate-900\/10/);
  assert.match(formSelect, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
  assert.match(formSelect, /event\.key === 'Escape'/);
  assert.match(formSelect, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(formSelect, /<CheckIcon \/>/);
});

test('议题保留讨论、备选方案、方案调整和决策，评审明确不阻塞下游', () => {
  assert.match(discovery, /讨论与决策时间线/);
  assert.match(discovery, /备选方案/);
  assert.match(discovery, /方案调整/);
  assert.match(discovery, /替代历史决策/);
  assert.match(discovery, /不影响提炼需求项或创建任务草稿/);
});

test('议题详情接口按时间倒序返回记录，页面首屏优先展示最新决策', () => {
  const useCases = readFileSync(new URL('../../../packages/application/src/requirement-collaboration-use-cases.ts', import.meta.url), 'utf8');
  assert.match(useCases, /requirementTopicEntries[\s\S]*orderBy\(desc\(schema\.requirementTopicEntries\.created_at\), desc\(schema\.requirementTopicEntries\.id\)\)/);
  assert.match(discovery, /detail\.entries\.map\(\(entry\) => <TopicEntryCard/);
});

test('议题详情展示来源想法，并区分想法汇聚与直接创建', () => {
  assert.match(discovery, /t\("由 \{0\} 个想法汇聚", \{ "0": detail\.ideas\.length \}\)/);
  assert.match(discovery, /直接创建的议题/);
  assert.match(discovery, /aria-label=\{t\("关联想法"\)\}/);
  assert.match(discovery, /idea\.detail/);
  assert.match(discovery, /idea\.source/);
  assert.match(discovery, /TopicIdeaCard/);
  assert.match(discovery, /initiallyOpen=\{detail\.ideas\.length === 1\}/);
  assert.match(discovery, /onToggle=\{\(event\) => setOpen\(event\.currentTarget\.open\)\}/);
  assert.doesNotMatch(discovery, /max-xl:hidden[^\n]*TopicContext/);
});

test('议题记录动作集中在标题栏，关联按钮说明具体对象', () => {
  const headerStart = discovery.indexOf('<header className="border-b border-slate-200 px-5 py-4">');
  const timelineStart = discovery.indexOf('讨论与决策时间线', headerStart);
  assert.ok(headerStart >= 0 && timelineStart > headerStart);
  let previousActionPosition = headerStart;
  for (const label of ['参与讨论', '备选方案', '形成决策', '方案调整']) {
    const position = discovery.indexOf(`>{t("${label}")}</button>`, headerStart);
    assert.ok(position > headerStart && position < timelineStart, `${label} 应位于议题标题栏`);
    assert.ok(position > previousActionPosition, `${label} 的按钮顺序不正确`);
    previousActionPosition = position;
  }
  assert.doesNotMatch(discovery, /反馈变化|>反馈</);
  assert.doesNotMatch(discovery.slice(timelineStart), /\+ 备选方案|\+ 方案调整/);
  assert.match(discovery, /border-amber-200 bg-amber-50 text-amber-800/);
  assert.match(discovery, /aria-label=\{t\("关联想法"\)\}/);
  assert.match(discovery, /aria-label=\{t\("关联文档"\)\}/);
  assert.match(discovery, /ui-context-action ui-context-action-accent/);
});

test('议题记录支持受约束的图片附件、提交前预览和时间线大图查看', () => {
  assert.match(discovery, /aria-label=\{t\("选择议题图片"\)\}/);
  assert.match(discovery, /最多 4 张，单张 2 MB/);
  assert.match(discovery, /image\/png,image\/jpeg,image\/webp,image\/gif/);
  assert.match(discovery, /readFileDataUrl/);
  assert.match(discovery, /图片处理中…/);
  assert.match(discovery, /图片读取失败，请重新选择/);
  assert.match(discovery, /移除图片：/);
  assert.match(discovery, /查看图片：/);
  assert.match(discovery, /ImagePreviewDialog/);
});

test('非决策议题记录支持软撤回并以占位替换正文和图片', () => {
  assert.match(discovery, /entry\.can_withdraw/);
  assert.match(discovery, /withdrawRequirementTopicEntry/);
  assert.match(discovery, /撤回这条记录？/);
  assert.match(discovery, /该记录已由/);
  assert.match(discovery, /时间线会保留撤回人、时间和审计记录/);
  assert.match(discovery, /决策记录不能撤回/);
});
