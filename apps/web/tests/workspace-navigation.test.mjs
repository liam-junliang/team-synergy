import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

let vite;
let navigation;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', server: { middlewareMode: true, hmr: false } });
  navigation = await vite.ssrLoadModule('/src/workspaceNavigation.ts');
});
after(async () => { await vite?.close(); });

function browserAt(href) {
  const events = new EventTarget();
  const clicks = new Set();
  const entries = [{ href, state: { retained: 'initial history state' } }];
  let index = 0;
  const browser = {
    get location() { return new URL(entries[index].href); },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    document: {
      addEventListener(type, handler) { assert.equal(type, 'click'); clicks.add(handler); },
      removeEventListener(type, handler) { assert.equal(type, 'click'); clicks.delete(handler); },
    },
    history: {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      pushState(state, _, destination) {
        entries.splice(index + 1, entries.length, { href: new URL(destination, browser.location.href).href, state });
        index += 1;
      },
      replaceState(state, _, destination) { entries[index] = { href: new URL(destination, browser.location.href).href, state }; },
      back() { if (index > 0) { index -= 1; events.dispatchEvent(new Event('popstate')); } },
      forward() { if (index < entries.length - 1) { index += 1; events.dispatchEvent(new Event('popstate')); } },
    },
    hash(hash) {
      browser.history.pushState(null, '', `${browser.location.pathname}${browser.location.search}${hash}`);
      events.dispatchEvent(new Event('hashchange'));
    },
    click(attributes, overrides = {}) {
      const anchor = { getAttribute: key => attributes[key] ?? null, hasAttribute: key => Object.hasOwn(attributes, key) };
      const event = { ...normalClick(), ...overrides, target: { closest: selector => selector === 'a[href]' ? anchor : null },
        preventDefault() { this.defaultPrevented = true; } };
      for (const handler of clicks) handler(event);
      return event;
    },
  };
  return browser;
}

function normalClick() { return { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }; }

test('History navigation updates route subscriptions and supports Back/Forward, replace and cleanup', () => {
  const browser = browserAt('https://app.example/teams');
  const routes = [];
  const stop = navigation.listenWorkspaceNavigation(route => routes.push(route), browser);
  assert.deepEqual(routes.at(-1), { view: 'teams' });
  assert.equal(navigation.navigateWorkspace('/projects/A/requirements?tab=documents&document=D', {}, browser), true);
  assert.deepEqual(routes.at(-1), { view: 'requirements', projectCode: 'A', requirementsTab: 'documents', documentCode: 'D' });
  assert.equal(browser.history.length, 2);
  navigation.navigateWorkspace('/projects/A/requirements?tab=documents&document=D', {}, browser);
  assert.equal(browser.history.length, 2, 'same route does not add duplicate history');
  navigation.navigateWorkspace('/account', { replace: true }, browser);
  assert.equal(browser.history.length, 2);
  assert.deepEqual(routes.at(-1), { view: 'account' });
  browser.history.back();
  assert.deepEqual(routes.at(-1), { view: 'teams' });
  browser.history.forward();
  assert.deepEqual(routes.at(-1), { view: 'account' });
  assert.equal(navigation.navigateWorkspace('https://external.example/projects/A/board', {}, browser), false);
  assert.equal(navigation.navigateWorkspace('/api/projects/A', {}, browser), false);
  const count = routes.length;
  stop();
  browser.history.back();
  navigation.navigateWorkspace('/projects/A/board', {}, browser);
  assert.equal(routes.length, count, 'cleanup removes native and application event listeners');
  assert.equal(browser.click({ href: '/teams' }).defaultPrevented, false, 'cleanup removes click interception');
});

test('legacy hash links canonicalize in place with query and state, while Markdown fragments remain native', () => {
  const browser = browserAt('https://app.example/stale?old=1#/projects/A/documents?document=D%2B1');
  assert.deepEqual(navigation.readWorkspaceRoute(browser.location), { view: 'documents', projectCode: 'A', documentCode: 'D+1' });
  const routes = [];
  const stop = navigation.listenWorkspaceNavigation(route => routes.push(route), browser);
  assert.equal(browser.location.href, 'https://app.example/projects/A/documents?document=D%2B1');
  assert.equal(browser.history.length, 1);
  assert.deepEqual(browser.history.state, { retained: 'initial history state' });
  browser.hash('#installation');
  assert.equal(browser.location.hash, '#installation');
  assert.equal(routes.length, 1, 'a heading does not trigger workspace navigation');
  assert.equal(navigation.canonicalizeWorkspaceLocation(browser), false);
  browser.hash('#/projects/B/handovers?handover=H1');
  assert.equal(browser.location.href, 'https://app.example/projects/B/handovers?handover=H1');
  assert.equal(browser.history.length, 3, 'legacy hash entry is replaced, not pushed again');
  assert.deepEqual(routes.at(-1), { view: 'handovers', projectCode: 'B', handoverCode: 'H1' });
  browser.history.back();
  assert.equal(browser.location.hash, '#installation');
  assert.deepEqual(routes.at(-1), { view: 'documents', projectCode: 'A', documentCode: 'D+1' });
  stop();
});

test('SPA intercepts only plain left clicks on known same-origin workspace paths', () => {
  const current = 'https://app.example/projects/A/documents?document=D';
  const destination = '/projects/B/documents?folder=RULES&create=document';
  const { workspaceNavigationTarget } = navigation;
  assert.equal(workspaceNavigationTarget(normalClick(), { href: destination }, current), destination);
  assert.equal(workspaceNavigationTarget(normalClick(), { href: `https://app.example${destination}` }, current), destination);
  for (const href of ['https://external.example/teams', '/api/projects/A', '/projects/A/home', '/projects/A/documents/download', '/assets/app.js', 'mailto:team@example.com', '#installation', '#/teams', `${destination}#setup`, `${destination}#`]) {
    assert.equal(workspaceNavigationTarget(normalClick(), { href }, current), null, href);
  }
  for (const overrides of [{ button: 1 }, { button: 2 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    assert.equal(workspaceNavigationTarget({ ...normalClick(), ...overrides }, { href: destination }, current), null);
  }
  for (const attributes of [{ download: true }, { target: '_blank' }, { target: '_self' }, { target: 'named-window' }, { rel: 'noopener external' }]) {
    assert.equal(workspaceNavigationTarget(normalClick(), { href: destination, ...attributes }, current), null);
  }
  const browser = browserAt(current);
  const routes = [];
  const stop = navigation.listenWorkspaceNavigation(route => routes.push(route), browser);
  const clicked = browser.click({ href: destination });
  assert.equal(clicked.defaultPrevented, true);
  assert.equal(browser.location.pathname + browser.location.search, destination);
  assert.deepEqual(routes.at(-1), { view: 'documents', projectCode: 'B', folderCode: 'RULES', createDocument: true });
  const count = routes.length;
  assert.equal(browser.click({ href: '/teams', download: '' }).defaultPrevented, false);
  assert.equal(browser.click({ href: '/teams' }, { ctrlKey: true }).defaultPrevented, false);
  assert.equal(browser.click({ href: '#setup' }).defaultPrevented, false);
  assert.equal(routes.length, count);
  stop();
});

test('旧需求功能模块入口替换为项目入口，保留查询上下文、页内锚点与当前历史条目', () => {
  for (const href of [
    'https://app.example/projects/A/requirements?tab=structure&module=M%2B1#details',
    'https://app.example/stale#/projects/A/requirements?tab=structure&module=M%2B1#details',
  ]) {
    const browser = browserAt(href);
    const routes = [];
    const stop = navigation.listenWorkspaceNavigation((route) => routes.push(route), browser);
    assert.equal(browser.location.href, 'https://app.example/projects/A/overview?tab=structure&module=M%2B1#details');
    assert.equal(browser.history.length, 1);
    assert.deepEqual(browser.history.state, { retained: 'initial history state' });
    assert.deepEqual(routes.at(-1), { view: 'overview', projectCode: 'A', projectTab: 'structure' });
    stop();
  }
  const browser = browserAt('https://app.example/projects/A/overview?tab=architecture&document=D#notes');
  assert.equal(navigation.canonicalizeWorkspaceLocation(browser), false);
  assert.equal(browser.location.hash, '#notes');
});
