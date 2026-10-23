import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let rendering;
let protocol;
let MarkdownDocument;
let DrawioDiagram;
let DrawioEditor;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><text x="5" y="20">架构</text></svg>';
const sourceA = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const sourceB = '<mxfile><diagram name="第二版"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom', server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  rendering = await vite.ssrLoadModule('/src/diagramRendering.ts');
  protocol = await vite.ssrLoadModule('/src/drawioProtocol.ts');
  ({ MarkdownDocument } = await vite.ssrLoadModule('/src/MarkdownDocument.tsx'));
  ({ DrawioDiagram } = await vite.ssrLoadModule('/src/DrawioDiagram.tsx'));
  ({ DrawioEditor } = await vite.ssrLoadModule('/src/DrawioEditor.tsx'));
});

after(async () => { await vite?.close(); });

test('Markdown mermaid fences use the shared diagram renderer without invalid pre/figure nesting', () => {
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { content: '# 架构\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n后续说明。' }));
  assert.match(html, /<figure[^>]*class="diagram-preview"/);
  assert.match(html, /正在生成图表/);
  assert.match(html, /Mermaid 图源/);
  assert.match(html, /flowchart LR\n A--&gt;B/);
  assert.match(html, /<h1[^>]*id="架构"/);
  assert.match(html, /后续说明/);
  assert.doesNotMatch(html, /<pre[^>]*>\s*<figure/);
});

test('Ordinary fences, inline code and raw HTML do not enable diagram rendering', () => {
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { content: '`mermaid A-->B`\n\n```javascript\nconst mermaid = 1;\n```\n\n```mermaid-extra\nA-->B\n```\n\n<pre class="mermaid">flowchart LR; A-->B</pre>' }));
  assert.doesNotMatch(html, /<figure/);
  assert.match(html, /class="language-javascript"/);
  assert.match(html, /class="language-mermaid-extra"/);
  assert.match(html, /&lt;pre class=/);
});

test('Multiple Markdown diagrams retain independent sources and never emit diagram HTML as DOM', () => {
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { content: '```mermaid\nflowchart LR\n A["<script>alert(1)</script>"]-->B\n```\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: Hello\n```' }));
  assert.equal((html.match(/<figure\b/g) ?? []).length, 2);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Alice-&gt;&gt;Bob/);
  assert.doesNotMatch(html, /<script\b/);
});

test('Mermaid uses a fixed strict policy and blocks source-level configuration overrides', () => {
  assert.equal(rendering.MERMAID_CONFIG.securityLevel, 'strict');
  assert.equal(rendering.MERMAID_CONFIG.htmlLabels, false);
  assert.equal(rendering.MERMAID_CONFIG.startOnLoad, false);
  assert.equal(rendering.MERMAID_CONFIG.suppressErrorRendering, true);
  for (const source of [
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR; A-->B',
    'flowchart LR\n%% { init: { themeCSS: "body {display:none}" } }%%\nA-->B',
    '\ufeff---\nconfig:\n securityLevel: loose\n---\nflowchart LR; A-->B',
    ' ', 'a'.repeat(rendering.MERMAID_MAX_SOURCE_LENGTH + 1),
  ]) assert.throws(() => rendering.validateMermaidSource(source));
  assert.doesNotThrow(() => rendering.validateMermaidSource('flowchart LR\n%% normal comment\nA-->B'));
});

test('Installed Mermaid parses flowcharts and sequences and rejects invalid syntax under the platform policy', async () => {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize(rendering.MERMAID_CONFIG);
  assert.match((await mermaid.parse('flowchart LR\n A-->B')).diagramType, /flowchart/);
  assert.equal((await mermaid.parse('sequenceDiagram\n Alice->>Bob: Hello')).diagramType, 'sequence');
  await assert.rejects(() => mermaid.parse('not-a-diagram\n A-->B'));
  await assert.rejects(() => mermaid.parse('flowchart LR\n A[unfinished'));
});

test('Mermaid rendering rejects config before import and respects cancellation before touching the DOM', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => rendering.renderMermaidImage('flowchart LR; A-->B', controller.signal), { name: 'AbortError' });
  await assert.rejects(() => rendering.renderMermaidImage('%%{init:{}}%%\nflowchart LR; A-->B', new AbortController().signal), /初始化指令/);
  const ids = Array.from({ length: 20 }, () => rendering.createMermaidRenderId());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-z][a-z0-9-]+$/i.test(id)));
});

test('Responsive Mermaid SVGs use their viewBox extent instead of an implicit 300px image width', () => {
  assert.deepEqual(rendering.mermaidImageDimensions('<svg width="100%" viewBox="0 0 1200 640"></svg>'), { width: 1200, height: 640 });
  assert.deepEqual(rendering.mermaidImageDimensions("<svg viewBox='-10 -5 960.5 500.25'></svg>"), { width: 960.5, height: 500.25 });
  assert.deepEqual(rendering.mermaidImageDimensions('<svg width="600px" viewBox="0,0,1200,640"></svg>'), { width: 600, height: 320 });
  assert.deepEqual(rendering.mermaidImageDimensions('<svg width="600" height="400" viewBox="0 0 1200 640"></svg>'), { width: 600, height: 400 });
  assert.deepEqual(rendering.mermaidImageDimensions('<svg width="100%" viewBox="0 0 40000 20000"></svg>'), { width: 20000, height: 10000 });
  for (const value of ['<svg viewBox="0 0 0 100"></svg>', '<svg viewBox="0 0 -1 100"></svg>', '<svg viewBox="0 0 NaN 100"></svg>', '<svg viewBox="0 0 Infinity 100"></svg>', '<svg viewBox="0 0 100"></svg>', '<svg></svg>']) {
    assert.equal(rendering.mermaidImageDimensions(value), undefined);
  }
});

test('SVG previews remain isolated image data, including script and HTML in untrusted SVG', () => {
  const unsafe = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><foreignObject><div>HTML</div></foreignObject></svg>';
  const html = renderToStaticMarkup(createElement(DrawioDiagram, { source: sourceA, previewSvg: unsafe }));
  assert.match(html, /<img[^>]*src="data:image\/svg\+xml;charset=utf-8,/);
  assert.doesNotMatch(html, /<(?:svg|script|foreignObject|iframe)\b/);
  assert.doesNotMatch(html, /<[^>]+\sonload=/);
  assert.match(html, /交互预览 \/ 查看所有页面/);
  for (const content of ['<html>hello</html>', '<!DOCTYPE svg><svg/>', '<svg><!ENTITY x SYSTEM "file:///x"></svg>', '<svg>' + 'x'.repeat(rendering.SVG_PREVIEW_MAX_BYTES) + '</svg>']) {
    assert.equal(rendering.svgImageUrl(content), null);
  }
});

test('XML-only diagrams get a sandboxed read-only iframe without putting diagram data in its URL', () => {
  const html = renderToStaticMarkup(createElement(DrawioDiagram, { source: sourceA }));
  assert.match(html, /<iframe\b/);
  assert.match(html, /chrome=0/);
  assert.match(html, /proto=json/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-downloads"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(html, /mxGraphModel|srcDoc|allow-top-navigation|allow-popups/);
  const editor = renderToStaticMarkup(createElement(DrawioEditor, { source: sourceA, onSave() {}, onClose() {} }));
  assert.equal(new URL(/<iframe[^>]+src="([^"]+)"/.exec(editor)[1]).origin, protocol.DRAWIO_ORIGIN);
  assert.match(editor, /chrome=1/);
  assert.match(editor, /draw.io 架构图编辑器/);
});

test('draw.io bridge requires both exact origin and the exact iframe window', () => {
  const frameWindow = {};
  const valid = { origin: protocol.DRAWIO_ORIGIN, source: frameWindow, data: JSON.stringify({ event: 'init' }) };
  assert.deepEqual(protocol.readDrawioEvent(valid, frameWindow), { event: 'init' });
  for (const overrides of [
    { origin: 'https://embed.diagrams.net.attacker.test' }, { origin: 'http://embed.diagrams.net' },
    { origin: 'null' }, { source: {} }, { data: { event: 'init' } },
    { data: 'not JSON' }, { data: '[]' }, { data: '{"event":"openLink","href":"javascript:alert(1)"}' },
  ]) assert.equal(protocol.readDrawioEvent({ ...valid, ...overrides }, frameWindow), null);
  assert.equal(protocol.readDrawioEvent(valid, null), null);
});

function sessionFixture(readOnly = false) {
  const sent = [], saved = [], errors = [], exits = [], exporting = [];
  let loads = 0;
  const session = protocol.createDrawioSession({
    source: sourceA, readOnly, send: (message) => sent.push(message),
    onLoaded: () => { loads += 1; }, onError: (message) => errors.push(message),
    onExporting: (source) => exporting.push(source), onSave: (result) => saved.push(result),
    onExit: (modified) => exits.push(modified),
  });
  return { session, sent, saved, errors, exits, exporting, get loads() { return loads; } };
}

const exportEvent = (request, overrides = {}) => ({ event: 'export', format: 'svg', message: request, data: `data:image/svg+xml,${encodeURIComponent(svg)}`, ...overrides });

test('draw.io initialization loads XML once and only sends a host-controlled configuration', () => {
  const fixture = sessionFixture();
  fixture.session.receive({ event: 'save', xml: sourceB });
  assert.equal(fixture.sent.length, 0);
  fixture.session.receive({ event: 'configure' });
  assert.deepEqual(fixture.sent[0], { action: 'configure', config: { suppressNewWindows: true, preserveViewState: true } });
  fixture.session.receive({ event: 'init' });
  assert.deepEqual(fixture.sent[1], { action: 'load', xml: sourceA, autosave: 0, modified: false, fit: 1, saveAndExit: 1 });
  fixture.session.receive({ event: 'init' });
  assert.equal(fixture.sent.length, 2);
  fixture.session.receive({ event: 'load' });
  assert.equal(fixture.loads, 1);
});

test('Each draw.io save exports its exact XML and obsolete exports cannot attach to a newer save', () => {
  const fixture = sessionFixture();
  fixture.session.receive({ event: 'init' });
  fixture.session.receive({ event: 'save', xml: sourceA });
  const firstRequest = fixture.sent.at(-1);
  fixture.session.receive({ event: 'save', xml: sourceB });
  const secondRequest = fixture.sent.at(-1);
  assert.equal(firstRequest.xml, sourceA);
  assert.equal(secondRequest.xml, sourceB);
  assert.notEqual(firstRequest.requestId, secondRequest.requestId);
  fixture.session.receive(exportEvent(firstRequest));
  fixture.session.receive(exportEvent({ ...secondRequest, xml: sourceA }));
  fixture.session.receive(exportEvent({ ...secondRequest, requestId: 'wrong-request' }));
  assert.equal(fixture.saved.length, 0);
  fixture.session.receive(exportEvent(JSON.stringify(secondRequest)));
  assert.deepEqual(fixture.saved, [{ source: sourceB, previewSvg: svg }]);
  fixture.session.receive(exportEvent(secondRequest));
  assert.equal(fixture.saved.length, 1, 'Exports cannot save the same revision twice');
});

test('Failed draw.io export preserves source-only recovery and clears obsolete preview results', () => {
  const fixture = sessionFixture();
  fixture.session.receive({ event: 'init' });
  fixture.session.receive({ event: 'save', xml: sourceB });
  const request = fixture.sent.at(-1);
  fixture.session.receive(exportEvent(request, { data: 'data:text/html,<script>alert(1)</script>' }));
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.session.hasPendingSource(), true);
  fixture.session.saveSourceOnly();
  assert.deepEqual(fixture.saved, [{ source: sourceB }]);
  fixture.session.receive(exportEvent(request));
  assert.equal(fixture.saved.length, 1);
  assert.equal(fixture.session.hasPendingSource(), false);
});

test('Save and Exit keeps the iframe alive until its matching export finishes', () => {
  const fixture = sessionFixture();
  fixture.session.receive({ event: 'init' });
  fixture.session.receive({ event: 'save', xml: sourceB, exit: true });
  const request = fixture.sent.at(-1);
  fixture.session.receive({ event: 'exit', modified: false });
  assert.equal(fixture.exits.length, 0);
  assert.equal(fixture.saved.length, 0);
  fixture.session.receive(exportEvent(request));
  assert.deepEqual(fixture.saved, [{ source: sourceB, previewSvg: svg }]);
});

test('Invalid newer source cancels an older pending export instead of saving an obsolete version', () => {
  const fixture = sessionFixture();
  fixture.session.receive({ event: 'init' });
  fixture.session.receive({ event: 'save', xml: sourceA });
  const request = fixture.sent.at(-1);
  fixture.session.receive({ event: 'save', xml: '<!DOCTYPE mxfile><mxfile/>' });
  fixture.session.receive(exportEvent(request));
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.session.hasPendingSource(), false);
});

test('Read-only, disposed, and unrelated draw.io sessions cannot trigger writes', () => {
  const viewer = sessionFixture(true);
  viewer.session.receive({ event: 'init' });
  viewer.session.receive({ event: 'save', xml: sourceB });
  viewer.session.receive({ event: 'exit', modified: true });
  assert.equal(viewer.sent[0].saveAndExit, 0);
  assert.equal(viewer.sent.length, 1);
  assert.equal(viewer.saved.length, 0);
  assert.equal(viewer.exits.length, 0);

  const editor = sessionFixture();
  editor.session.receive({ event: 'init' });
  editor.session.receive({ event: 'save', xml: sourceA });
  const request = editor.sent.at(-1);
  editor.session.dispose();
  editor.session.receive(exportEvent(request));
  editor.session.saveSourceOnly();
  assert.equal(editor.saved.length, 0);

  const replacement = sessionFixture();
  replacement.session.receive({ event: 'init' });
  replacement.session.receive({ event: 'save', xml: sourceA });
  replacement.session.receive(exportEvent(request));
  assert.equal(replacement.saved.length, 0, 'A previous iframe session cannot supply the new preview');
});

test('draw.io SVG decoder accepts Unicode percent/base64 data and rejects non-SVG or malformed payloads', () => {
  assert.equal(protocol.decodeDrawioSvg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`), svg);
  assert.equal(protocol.decodeDrawioSvg(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`), svg);
  for (const value of [null, svg, 'data:text/html,<svg/>', 'javascript:alert(1)', 'data:image/svg+xml,%E0%A4%A', 'data:image/svg+xml;base64,!!', 'data:image/svg+xml,<html/>']) {
    assert.equal(protocol.decodeDrawioSvg(value), null);
  }
});

test('draw.io message boundary rejects malformed event fields before session callbacks run', () => {
  const frameWindow = {};
  const envelope = value => ({ origin: protocol.DRAWIO_ORIGIN, source: frameWindow, data: JSON.stringify(value) });
  const request = { action: 'export', format: 'svg', requestId: 'request-1', xml: sourceA };
  for (const value of [
    { event: 'save' }, { event: 'save', xml: {} }, { event: 'save', xml: sourceA, exit: 'true' },
    { event: 'save', xml: 'x'.repeat(6 * 1024 * 1024 + 1) },
    { event: 'save', xml: '界'.repeat(2 * 1024 * 1024 + 1) },
    { event: 'load', error: {} }, { event: 'load', xml: [] },
    { event: 'exit' }, { event: 'exit', modified: 'false' }, { event: 'exit', modified: 0 },
    { event: 'export', format: 'html', message: request, data: 'data:text/html,hello' },
    { event: 'export', format: 'svg', message: [], data: 'data:image/svg+xml,<svg/>' },
    { event: 'export', format: 'svg', message: 'bad JSON', data: 'data:image/svg+xml,<svg/>' },
    { event: 'export', format: 'svg', message: { ...request, action: 'load' }, data: 'data:image/svg+xml,<svg/>' },
    { event: 'export', format: 'svg', message: { ...request, requestId: 123 }, data: 'data:image/svg+xml,<svg/>' },
    { event: 'export', format: 'svg', message: request, data: {} },
    { event: 'export', format: 'svg', message: request, data: 'data:image/svg+xml,<svg/>', error: {} },
  ]) assert.equal(protocol.readDrawioEvent(envelope(value), frameWindow), null, JSON.stringify(value).slice(0, 160));

  for (const value of [
    { event: 'configure', version: 'future' }, { event: 'init' }, { event: 'load', error: null, scale: 1 },
    { event: 'save', xml: sourceA, exit: true }, { event: 'exit', modified: false },
    exportEvent(request), exportEvent(JSON.stringify(request)),
    { event: 'export', format: 'svg', message: request, error: 'export failed' },
  ]) assert.deepEqual(protocol.readDrawioEvent(envelope(value), frameWindow), value);
});

test('draw.io gated bridge preserves edit/export/preview flow and ignores forged state changes', () => {
  const fixture = sessionFixture();
  const frameWindow = {};
  const receive = (value, overrides = {}) => {
    const event = protocol.readDrawioEvent({ origin: protocol.DRAWIO_ORIGIN, source: frameWindow, data: JSON.stringify(value), ...overrides }, frameWindow);
    if (event) fixture.session.receive(event);
  };
  receive({ event: 'configure' }); receive({ event: 'init' }); receive({ event: 'load', error: null });
  receive({ event: 'save', xml: sourceB, exit: true });
  const request = fixture.sent.at(-1);
  for (const overrides of [{ origin: 'null' }, { origin: 'https://attacker.test' }, { source: {} }]) receive(exportEvent(request), overrides);
  receive({ event: 'exit', modified: 'false' });
  receive({ ...exportEvent(request), message: { ...request, action: 'load' } });
  assert.deepEqual(fixture.saved, []); assert.deepEqual(fixture.exits, []);
  assert.equal(fixture.loads, 1);
  receive(exportEvent(JSON.stringify(request)));
  assert.deepEqual(fixture.saved, [{ source: sourceB, previewSvg: svg }]);
  receive({ event: 'exit', modified: false });
  assert.deepEqual(fixture.exits, [false]);
});
