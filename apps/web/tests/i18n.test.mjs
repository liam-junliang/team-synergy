import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { englishMessages, formatDate, formatDateTime, formatNumber, getLocale, initializeLocale, LOCALE_STORAGE_KEY, resolveLocale, setLocale, subscribeLocale, systemFolderName, t, translate } from '../src/i18n.ts';
import { ApiError } from '../src/apiError.ts';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  setLocale('zh-CN', false);
});

test('locale resolution honors saved preference, supported browser languages, then Chinese fallback', () => {
  assert.equal(resolveLocale('en-US', ['zh-CN']), 'en-US');
  assert.equal(resolveLocale('zh-CN', ['en-GB']), 'zh-CN');
  assert.equal(resolveLocale('invalid', ['fr-FR', 'en-GB']), 'en-US');
  assert.equal(resolveLocale(null, ['zh-TW']), 'zh-CN');
  assert.equal(resolveLocale(null, ['de-DE']), 'zh-CN');
});

test('language preference survives reload, updates metadata and follows cross-tab changes', () => {
  const values = new Map([[LOCALE_STORAGE_KEY, 'en-US']]);
  const events = new Map();
  globalThis.window = {
    navigator: { languages: ['zh-CN'] },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener: (name, handler) => events.set(name, handler),
    removeEventListener: (name) => events.delete(name),
  };
  globalThis.document = { documentElement: { lang: '' }, title: '' };
  let notifications = 0;
  const unsubscribe = subscribeLocale(() => { notifications++; });
  const dispose = initializeLocale();
  assert.equal(getLocale(), 'en-US');
  assert.equal(document.documentElement.lang, 'en-US');
  assert.equal(document.title, 'Team Synergy · Project workspace');
  setLocale('zh-CN');
  assert.equal(values.get(LOCALE_STORAGE_KEY), 'zh-CN');
  assert.equal(document.documentElement.lang, 'zh-CN');
  events.get('storage')({ key: LOCALE_STORAGE_KEY, newValue: 'en-US' });
  assert.equal(getLocale(), 'en-US');
  events.get('storage')({ key: 'unrelated', newValue: 'zh-CN' });
  assert.equal(getLocale(), 'en-US');
  events.get('storage')({ key: null, newValue: null });
  assert.equal(getLocale(), 'zh-CN');
  assert.equal(notifications, 4);
  unsubscribe(); dispose();
  assert.equal(events.size, 0);
});

test('blocked storage does not prevent language switching', () => {
  globalThis.window = {
    navigator: { languages: ['en-US'] },
    get localStorage() { throw new Error('storage blocked'); },
    addEventListener() {}, removeEventListener() {},
  };
  const dispose = initializeLocale();
  assert.equal(getLocale(), 'en-US');
  assert.doesNotThrow(() => setLocale('zh-CN'));
  assert.equal(getLocale(), 'zh-CN');
  dispose();
});

test('translation interpolates data once without changing user content or unknown keys', () => {
  assert.equal(translate('en-US', '查看任务：{p0}', { p0: '项目规范 {p1}' }), 'View task: 项目规范 {p1}');
  assert.equal(translate('en-US', '任务：{count}', { count: 1234 }), 'Tasks: 1,234');
  assert.equal(translate('zh-CN', '任务：{count}', { count: 3 }), '任务：3');
  assert.equal(translate('en-US', 'Custom content'), 'Custom content');
  for (const value of ['constructor', 'toString', '__proto__']) assert.equal(translate('en-US', value), value);
  assert.equal(translate('en-US', '查看任务：{p0}'), 'View task: {p0}');
});

test('all source message placeholders are preserved by the English catalog', () => {
  const tokens = (value) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
  for (const [key, translated] of Object.entries(englishMessages)) {
    assert.deepEqual(tokens(translated), tokens(key), `Placeholder mismatch: ${key}`);
    assert.ok(translated.trim(), `Empty translation: ${key}`);
  }
});

test('dates use the selected locale and keep calendar-only values in local time', () => {
  setLocale('en-US', false);
  assert.equal(formatDate('2026-10-16'), new Intl.DateTimeFormat('en-US').format(new Date(2026, 9, 16)));
  assert.equal(formatNumber(1234.5), '1,234.5');
  assert.equal(formatDateTime('bad-date'), '—');
  assert.equal(formatDate(null), '—');
  setLocale('zh-CN', false);
  assert.equal(formatDate('2026-10-16'), '2026/10/16');
});

test('system folder labels use role and leave custom folder names untouched', () => {
  setLocale('en-US', false);
  assert.equal(systemFolderName({name: '项目规范', system_role: 'standards'}), 'Project standards');
  assert.equal(systemFolderName({name: '需求文档', system_role: 'requirements'}), 'Requirements documents');
  assert.equal(systemFolderName({name: '架构设计', system_role: 'architecture'}), 'Architecture');
  assert.equal(systemFolderName({name: '项目规范'}), '项目规范');
});

test('known API errors follow language changes and unknown server details remain intact', () => {
  const error = new ApiError('architecture_document_revision_conflict', '版本冲突', 409);
  assert.equal(error.message, 'architecture_document_revision_conflict: 版本冲突');
  setLocale('en-US', false);
  assert.match(error.message, /newer diagram version/);
  assert.equal(error.originalMessage, '版本冲突');
  assert.equal(new ApiError('constructor', 'original detail', 400).message, 'constructor: original detail');
  assert.match(new ApiError('testing_revision_conflict', '版本冲突', 409).message, /merge your changes/);
  assert.match(new ApiError('testing_defect_conflict', '缺陷冲突', 409).message, /already has a linked defect/);
  assert.match(new ApiError('testing_invalid', '字段不正确', 422).message, /required execution fields/);
  assert.equal(error.status, 409);
  assert.equal(new ApiError('custom_error', '项目A：详细原因', 400).message, 'custom_error: 项目A：详细原因');
  setLocale('zh-CN', false);
  assert.equal(error.message, 'architecture_document_revision_conflict: 版本冲突');
});
