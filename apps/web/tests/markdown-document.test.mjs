import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let MarkdownDocument;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ MarkdownDocument } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx'));
});

after(async () => { await vite?.close(); });

const render = (content, outline) => renderToStaticMarkup(createElement(MarkdownDocument, { content, outline }));
const headings = (html) => [...html.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g)].map((match) => ({
  level: Number(match[1]),
  id: /\bid="([^"]*)"/.exec(match[2])?.[1],
  text: match[3].replace(/<[^>]+>/g, ''),
}));

test('Markdown renders GFM tables with column alignment and inline cell content', () => {
  const html = render('| 左侧 | 居中 | 右侧 |\n| :--- | :---: | ---: |\n| **名称** | `值` | 42 |');
  assert.match(html, /<table\b/);
  assert.match(html, /<thead\b[\s\S]*?<th\b[^>]*(?:align="left"|text-align:left)[^>]*>左侧<\/th>/);
  assert.match(html, /<th\b[^>]*(?:align="center"|text-align:center)[^>]*>居中<\/th>/);
  assert.match(html, /<th\b[^>]*(?:align="right"|text-align:right)[^>]*>右侧<\/th>/);
  assert.match(html, /<tbody\b[\s\S]*?<td\b[^>]*><strong\b[^>]*>名称<\/strong><\/td>/);
  assert.match(html, /<td\b[^>]*><code\b[^>]*>值<\/code><\/td>/);
});

test('Markdown renders task lists as disabled checkboxes with their checked state', () => {
  const html = render('- [x] 已完成\n- [ ] 待处理');
  const inputs = html.match(/<input\b[^>]*>/g) ?? [];
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.match(input, /\btype="checkbox"/);
    assert.match(input, /\bdisabled(?:="")?(?:\s|\/?>)/);
  }
  assert.match(inputs[0], /\bchecked(?:="")?(?:\s|\/?>)/);
  assert.doesNotMatch(inputs[1], /\bchecked(?:=|\s|\/?>)/);
  assert.match(html, /已完成/);
  assert.match(html, /待处理/);
});

test('Markdown preserves nested ordered and unordered list structure and numbering', () => {
  const html = render('3. 第一项\n   - 子项甲\n   - 子项乙\n4. 第二项\n\n- 无序父项\n  1. 有序子项');
  assert.equal((html.match(/<ol\b/g) ?? []).length, 2);
  assert.equal((html.match(/<ul\b/g) ?? []).length, 2);
  assert.match(html, /<ol\b[^>]*\bstart="3"[^>]*>[\s\S]*?<li\b[^>]*>第一项\s*<ul\b/);
  assert.match(html, /<li\b[^>]*>子项甲<\/li>\s*<li\b[^>]*>子项乙<\/li>/);
  assert.match(html, /<li\b[^>]*>无序父项\s*<ol\b[^>]*>\s*<li\b[^>]*>有序子项<\/li>/);
});

test('Markdown keeps all six semantic heading levels', () => {
  const html = render(Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} 标题${index + 1}`).join('\n\n'));
  assert.deepEqual(headings(html).map(({ level, text }) => ({ level, text })),
    Array.from({ length: 6 }, (_, index) => ({ level: index + 1, text: `标题${index + 1}` })));
});

test('Markdown groups paragraphs and renders blockquotes, emphasis, deletion and thematic breaks', () => {
  const html = render('第一行\n同一段第二行\n\n第二段包含 *强调* 和 ~~删除~~。\n\n> 引用第一行\n> 引用第二行\n\n---');
  assert.match(html, /<p\b[^>]*>第一行\s+同一段第二行<\/p>/);
  assert.match(html, /<em\b[^>]*>强调<\/em>/);
  assert.match(html, /<del\b[^>]*>删除<\/del>/);
  assert.match(html, /<blockquote\b[^>]*>\s*<p\b[^>]*>引用第一行\s+引用第二行<\/p>\s*<\/blockquote>/);
  assert.match(html, /<hr\b[^>]*\/?\s*>/);
});

test('Markdown escapes inline and fenced code while preserving fence language', () => {
  const html = render('内联 `<img src=x onerror=alert(1)>`\n\n```html\n<script>alert("x")</script>\n<div>& value</div>\n```');
  assert.match(html, /<code\b[^>]*>&lt;img src=x onerror=alert\(1\)&gt;<\/code>/);
  assert.match(html, /<pre\b[^>]*><code\b[^>]*class="[^"]*\blanguage-html\b[^"]*"[^>]*>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;div&gt;&amp; value&lt;\/div&gt;/);
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
});

test('Markdown renders normal links and image alternative text', () => {
  const html = render('[使用说明](https://example.com/guide?q=1&lang=zh "查看说明")\n\n![界面预览](https://example.com/preview.png "页面截图")');
  assert.match(html, /<a\b[^>]*href="https:\/\/example\.com\/guide\?q=1&amp;lang=zh"[^>]*>使用说明<\/a>/);
  assert.match(html, /<a\b[^>]*title="查看说明"/);
  const image = html.match(/<img\b[^>]*>/)?.[0];
  assert.ok(image, 'Markdown image should render an img element');
  assert.match(image, /\bsrc="https:\/\/example\.com\/preview\.png"/);
  assert.match(image, /\balt="界面预览"/);
});

test('Markdown never emits executable raw HTML or dangerous link and image protocols', () => {
  const html = render([
    '[危险链接](javascript:alert%281%29)',
    '[实体协议](javascript&#x3A;alert%281%29)',
    '[数据链接](data:text/html;base64,PHNjcmlwdD4=)',
    '![危险图片](javascript:alert%281%29)',
    '<script>globalThis.markdownExecuted = true</script>',
    '<img src="x" onerror="alert(1)">',
    '<iframe src="https://example.com"></iframe>',
  ].join('\n\n'));
  assert.doesNotMatch(html, /<(?:script|iframe)\b/i);
  assert.doesNotMatch(html, /<[^>]+\s(?:onerror|onload|onclick)\s*=/i);
  assert.doesNotMatch(html, /\b(?:href|src)="\s*(?:javascript|vbscript|data):/i);
  assert.match(html, /危险链接/);
  assert.match(html, /实体协议/);
});

test('Markdown assigns stable unique IDs to Chinese, duplicate and punctuation-only headings', () => {
  const content = '# 项目规范\n\n## 项目规范\n\n## 项目规范-1\n\n## 项目规范\n\n### !!!\n\n### !!!';
  const first = headings(render(content));
  assert.equal(first.length, 6);
  assert.ok(first.every(heading => typeof heading.id === 'string' && heading.id.length > 0));
  assert.equal(new Set(first.map(heading => heading.id)).size, first.length);
  assert.deepEqual(headings(render(content)), first, 'IDs must be deterministic across renders');
});

test('Markdown keeps explicit outline anchors for matching headings', () => {
  const html = render('# 总览\n\n## 设计目标', [
    { level: 1, title: '总览', anchor: 'custom-overview' },
    { level: 2, title: '设计目标', anchor: 'custom-target' },
  ]);
  assert.deepEqual(headings(html).map(heading => heading.id), ['custom-overview', 'custom-target']);
});

test('Markdown outline matching ignores fenced pseudo-headings and missing high-level entries', () => {
  const html = render('# 总览\n\n```md\n## 围栏假标题\n```\n\n#### 四级标题\n\n## 真实目标\n\n###### 六级标题\n\n### 验收条件', [
    { level: 1, title: '总览', anchor: 'custom-overview' },
    { level: 2, title: '围栏假标题', anchor: 'code-only-heading' },
    { level: 2, title: '真实目标', anchor: 'custom-target' },
    { level: 3, title: '验收条件', anchor: 'custom-acceptance' },
  ]);
  const rendered = headings(html);
  assert.equal(rendered.length, 5);
  assert.equal(rendered.find(heading => heading.text === '真实目标')?.id, 'custom-target');
  assert.equal(rendered.find(heading => heading.text === '验收条件')?.id, 'custom-acceptance');
  assert.equal(rendered.find(heading => heading.text === '四级标题')?.level, 4);
  assert.equal(rendered.find(heading => heading.text === '六级标题')?.level, 6);
  assert.ok(rendered.every(heading => heading.id !== 'code-only-heading'));
  assert.equal(new Set(rendered.map(heading => heading.id)).size, rendered.length);
});

test('Markdown distinguishes a fenced pseudo-heading from a real heading with the same title', () => {
  const html = render('# 总览\n\n```md\n## 相同标题\n```\n\n## 相同标题\n\n#### 补充\n\n###### 深层标题\n\n## 收尾', [
    { level: 1, title: '总览', anchor: 'custom-overview' },
    { level: 2, title: '相同标题', anchor: 'code-only-heading' },
    { level: 2, title: '相同标题', anchor: 'real-heading' },
    { level: 4, title: '补充', anchor: 'custom-details' },
    { level: 2, title: '收尾', anchor: 'custom-end' },
  ]);
  const rendered = headings(html);
  assert.equal(rendered.find(heading => heading.text === '相同标题')?.id, 'real-heading');
  assert.equal(rendered.find(heading => heading.text === '补充')?.id, 'custom-details');
  assert.equal(rendered.find(heading => heading.text === '收尾')?.id, 'custom-end');
  assert.ok(rendered.every(heading => heading.id !== 'code-only-heading'));
});

test('Markdown retains the first explicit anchor without producing duplicate heading IDs', () => {
  const html = render('# 约定\n\n## 约定\n\n## 另一个标题', [
    { level: 1, title: '约定', anchor: 'same-anchor' },
    { level: 2, title: '约定', anchor: 'same-anchor' },
    { level: 2, title: '另一个标题', anchor: 'custom-other' },
  ]);
  const rendered = headings(html);
  assert.equal(rendered[0].id, 'same-anchor');
  assert.equal(rendered[2].id, 'custom-other');
  assert.equal(new Set(rendered.map(heading => heading.id)).size, rendered.length);
});

function anchorFixture(href = '#设计目标', linkAttributes = {}) {
  const calls = { prevented: 0, scrolled: 0, focused: 0 };
  const attributes = new Map();
  const heading = {
    id: '设计目标',
    scrollIntoView() { calls.scrolled += 1; },
    focus() { calls.focused += 1; },
    hasAttribute(name) { return attributes.has(name); },
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const link = { getAttribute: (name) => name === 'href' ? href : linkAttributes[name] ?? null };
  const container = {
    contains: (element) => element === link || element === heading,
    querySelectorAll: () => [heading],
  };
  const event = {
    target: { closest: () => link },
    currentTarget: container,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() { calls.prevented += 1; },
  };
  return { calls, attributes, heading, container, event };
}

test('Markdown anchor scrolling resolves encoded Chinese IDs within its own document and focuses the heading', async () => {
  const { scrollToMarkdownAnchor } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const fixture = anchorFixture();
  assert.equal(scrollToMarkdownAnchor(fixture.container, '#%E8%AE%BE%E8%AE%A1%E7%9B%AE%E6%A0%87'), true);
  assert.equal(fixture.calls.scrolled, 1);
  assert.equal(fixture.calls.focused, 1);
  assert.equal(fixture.attributes.get('tabindex'), '-1');
  fixture.attributes.set('tabindex', '0');
  assert.equal(scrollToMarkdownAnchor(fixture.container, '设计目标'), true);
  assert.equal(fixture.attributes.get('tabindex'), '0', 'Preserve an existing focus order');
  fixture.heading.id = '引用[1]"';
  assert.equal(scrollToMarkdownAnchor(fixture.container, `#${encodeURIComponent(fixture.heading.id)}`), true);
});

test('Markdown anchor scrolling does not escape its document or throw on malformed fragments', async () => {
  const { scrollToMarkdownAnchor } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const fixture = anchorFixture();
  for (const anchor of ['#missing', '#%E0%A4%A', '#another-document-heading']) {
    assert.equal(scrollToMarkdownAnchor(fixture.container, anchor), false);
  }
  assert.equal(scrollToMarkdownAnchor(null, '#设计目标'), false);
  assert.equal(fixture.calls.scrolled, 0);
  assert.equal(fixture.calls.focused, 0);
});

test('Markdown fragment clicks scroll and focus their local heading', async () => {
  const { handleMarkdownAnchorClick } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  for (const href of ['#设计目标', '#%E8%AE%BE%E8%AE%A1%E7%9B%AE%E6%A0%87']) {
    const fixture = anchorFixture(href);
    handleMarkdownAnchorClick(fixture.event);
    assert.equal(fixture.calls.prevented, 1);
    assert.equal(fixture.calls.scrolled, 1);
    assert.equal(fixture.calls.focused, 1);
  }
});

test('Markdown local anchor navigation retains the pathname and records the fragment in browser history', async (t) => {
  const { handleMarkdownAnchorClick } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let currentUrl = new URL('https://workspace.test/projects/PROJECT-A/documents/DOC-A');
  const historyEntries = [];
  const history = {
    state: { page: 'document' },
    pushState(state, _title, url) {
      currentUrl = new URL(url, currentUrl);
      historyEntries.push({ state, url: currentUrl.href });
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { history, get location() { return currentUrl; } } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  });
  const fixture = anchorFixture('#%E8%AE%BE%E8%AE%A1%E7%9B%AE%E6%A0%87');
  handleMarkdownAnchorClick(fixture.event);
  assert.equal(currentUrl.pathname, '/projects/PROJECT-A/documents/DOC-A');
  assert.equal(decodeURIComponent(currentUrl.hash), '#设计目标');
  assert.equal(historyEntries.length, 1);
  assert.deepEqual(historyEntries[0].state, history.state);
  assert.equal(fixture.calls.scrolled, 1);
  handleMarkdownAnchorClick(fixture.event);
  assert.equal(historyEntries.length, 1, 'Clicking the current fragment should not add a duplicate history entry');
  assert.equal(fixture.calls.scrolled, 2);
});

test('Markdown does not intercept application routes, external links, modified clicks or events outside its document', async () => {
  const { handleMarkdownAnchorClick } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const cases = [
    ['/projects/PROJECT-A', {}],
    ['https://example.com/#设计目标', {}],
    ['#设计目标', { ctrlKey: true }],
    ['#设计目标', { metaKey: true }],
    ['#设计目标', { shiftKey: true }],
    ['#设计目标', { altKey: true }],
    ['#设计目标', { button: 1 }],
    ['#设计目标', { defaultPrevented: true }],
    ['#设计目标', { target: null }],
  ];
  for (const [href, overrides] of cases) {
    const fixture = anchorFixture(href);
    handleMarkdownAnchorClick({ ...fixture.event, ...overrides });
    assert.equal(fixture.calls.prevented, 0);
    assert.equal(fixture.calls.scrolled, 0);
  }
  const foreign = anchorFixture();
  foreign.container.contains = () => false;
  handleMarkdownAnchorClick(foreign.event);
  assert.equal(foreign.calls.prevented, 0);
  assert.equal(foreign.calls.scrolled, 0);
  for (const attributes of [{ target: '_blank' }, { target: 'preview' }, { download: '' }]) {
    const fixture = anchorFixture('#设计目标', attributes);
    handleMarkdownAnchorClick(fixture.event);
    assert.equal(fixture.calls.prevented, 0);
    assert.equal(fixture.calls.scrolled, 0);
  }
});

test('Markdown restores an initial fragment once its asynchronously loaded heading becomes available', async () => {
  const { restoreMarkdownFragment } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const fixture = anchorFixture();
  let available = false;
  fixture.container.ownerDocument = { getElementById: (id) => available && id === fixture.heading.id ? fixture.heading : null };
  fixture.container.querySelectorAll = () => available ? [fixture.heading] : [];
  const fragment = '#%E8%AE%BE%E8%AE%A1%E7%9B%AE%E6%A0%87';
  assert.equal(restoreMarkdownFragment(fixture.container, fragment), false);
  assert.equal(fixture.calls.scrolled, 0);
  available = true;
  assert.equal(restoreMarkdownFragment(fixture.container, fragment), true);
  assert.equal(fixture.calls.scrolled, 1);
  assert.equal(fixture.calls.focused, 1);
  assert.equal(fixture.attributes.get('tabindex'), '-1');
});

test('Markdown initial restoration ignores absent, malformed and legacy application fragments', async () => {
  const { restoreMarkdownFragment } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const fixture = anchorFixture();
  fixture.container.ownerDocument = { getElementById: (id) => id === fixture.heading.id ? fixture.heading : null };
  for (const fragment of ['', '#', '设计目标', '#missing', '#%E0%A4%A', '#/projects/PROJECT-A/documents']) {
    assert.equal(restoreMarkdownFragment(fixture.container, fragment), false, fragment);
  }
  assert.equal(restoreMarkdownFragment(null, '#设计目标'), false);
  assert.equal(fixture.calls.scrolled, 0);
  assert.equal(fixture.calls.focused, 0);
});

test('Markdown initial restoration focuses only the first matching document when containers repeat heading IDs', async () => {
  const { restoreMarkdownFragment } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx');
  const first = anchorFixture();
  const second = anchorFixture();
  const ownerDocument = { getElementById: (id) => id === first.heading.id ? first.heading : null };
  first.container.ownerDocument = ownerDocument;
  second.container.ownerDocument = ownerDocument;
  assert.equal(restoreMarkdownFragment(second.container, '#设计目标'), false);
  assert.equal(restoreMarkdownFragment(first.container, '#设计目标'), true);
  assert.equal(first.calls.scrolled, 1);
  assert.equal(first.calls.focused, 1);
  assert.equal(second.calls.scrolled, 0);
  assert.equal(second.calls.focused, 0);
});
