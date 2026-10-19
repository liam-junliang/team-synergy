import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Use Vite's existing CSS parser to check the generated cascade, not just class strings.
const { parse } = createRequire(import.meta.resolve('vite'))('postcss');
let stylesheet;

before(async () => {
  const result = await build({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    build: { write: false, minify: false, cssMinify: false },
  });
  const css = result.output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  assert.ok(css.length, 'Web build must produce styles');
  stylesheet = parse(css.map(item => item.source).join('\n'));
});

function layerOf(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name === 'layer') return parent.params;
  }
  return null;
}

function ruleFor(selector) {
  let found;
  stylesheet.walkRules(rule => { if (rule.selector === selector) found = rule; });
  assert.ok(found, `Missing compiled rule: ${selector}`);
  return found;
}

function valueOf(rule, property) {
  return rule.nodes.find(node => node.type === 'decl' && node.prop === property)?.value;
}

test('compiled control font resets stay in base so component and utility typography can win', () => {
  let resets = 0;
  stylesheet.walkRules(rule => {
    if (!/(?:^|,)\s*(?:button|input|select|textarea)\s*(?:,|$)/.test(rule.selector)) return;
    for (const declaration of rule.nodes.filter(node => node.type === 'decl' && /^(?:font|font-size|font-weight|line-height)$/.test(node.prop))) {
      resets += 1;
      assert.equal(layerOf(rule), 'base', `${rule.selector}: ${declaration.prop} overrides component typography`);
    }
  });
  assert.ok(resets > 0, 'Tailwind preflight supplies the base control reset');
});

test('compiled buttons and segmented choices share the same readable control type size', () => {
  const button = ruleFor('.ui-button');
  for (const selector of ['.ui-segmented-item', '.ui-context-action']) {
    const rule = ruleFor(selector);
    assert.equal(valueOf(rule, 'font-size'), valueOf(button, 'font-size'));
    assert.equal(valueOf(rule, 'line-height'), valueOf(button, 'line-height'));
    assert.equal(layerOf(rule), 'components');
  }
  assert.equal(valueOf(button, 'font-size'), 'var(--text-xs)');
  assert.equal(valueOf(ruleFor('.ui-segmented-item'), 'height'), 'calc(var(--spacing) * 7)');
});

test('compiled form styles define readable input text independently of label inheritance', () => {
  const form = ruleFor('.form-control');
  assert.equal(valueOf(form, 'font-size'), 'var(--text-sm)');
  assert.equal(valueOf(form, 'font-weight'), 'var(--font-weight-normal)');
  assert.equal(valueOf(form, 'min-height'), 'calc(var(--spacing) * 10)');
  const compact = ruleFor('.form-control-compact');
  assert.equal(valueOf(compact, 'font-size'), valueOf(ruleFor('.ui-button'), 'font-size'));
  assert.equal(valueOf(compact, 'height'), 'calc(var(--spacing) * 8)');
});

test('shared control styles stay below utilities so local layout and editor fonts remain effective', () => {
  for (const selector of ['.ui-button', '.ui-button-compact', '.form-control', '.form-control-compact', '.ui-field-label']) {
    assert.equal(layerOf(ruleFor(selector)), 'components', `${selector} must allow ordinary utility overrides`);
  }
});

test('document sidebars stick only in desktop columns and bound their height to the viewport', () => {
  const base = {};
  const desktop = {};
  stylesheet.walkDecls(declaration => {
    let sidebar = false;
    let media;
    for (let parent = declaration.parent; parent; parent = parent.parent) {
      if (parent.type === 'rule' && parent.selector === '.document-library-sidebar') sidebar = true;
      if (parent.type === 'atrule' && parent.name === 'media') media = parent.params;
    }
    if (!sidebar) return;
    if (media === undefined) base[declaration.prop] = declaration.value;
    else if (/^\((?:width\s*>=|min-width:)\s*80rem\)$/.test(media)) desktop[declaration.prop] = declaration.value;
  });
  assert.equal(base.display, 'flex');
  assert.ok(['0', '0px', 'calc(var(--spacing) * 0)'].includes(base['min-height']));
  assert.equal(base.overflow, 'hidden');
  assert.equal(base.position, undefined, 'stacked narrow layouts must scroll normally');
  assert.equal(desktop.position, 'sticky', 'sticky starts at the same xl breakpoint as the two-column layout');
  assert.ok(['0', '0px', 'calc(var(--spacing) * 0)'].includes(desktop.top));
  assert.match(desktop.height, /100dvh/);
  assert.match(desktop['max-height'], /100dvh/, 'short desktop windows must not clip the end of the list');
});

test('Markdown anchor offsets include the actual reader header height', () => {
  assert.match(valueOf(ruleFor('.markdown-document :where([id])'), 'scroll-margin-top'), /var\(--document-reader-header-height,\s*0px\)\s*\+\s*1\.5rem/);
});
