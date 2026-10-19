import { isWorkspacePath, legacyWorkspacePath, migratedProjectStructurePath, parseWorkspacePath, type WorkspaceRoute } from './workspaceRouting';

const NAVIGATION_EVENT = 'acp:workspace-navigation';
type WorkspaceBrowser = Pick<Window, 'location' | 'history' | 'document' | 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;

export function readWorkspaceRoute(location: Pick<Location, 'pathname' | 'search' | 'hash'>): WorkspaceRoute {
  return parseWorkspacePath(legacyWorkspacePath(location.hash) ?? `${location.pathname}${location.search}`);
}

/** Replace an old hash route in place, preserving its query and history entry. */
export function canonicalizeWorkspaceLocation(browser: WorkspaceBrowser = window): boolean {
  const legacyPath = legacyWorkspacePath(browser.location.hash);
  const path = migratedProjectStructurePath(legacyPath ?? `${browser.location.pathname}${browser.location.search}${browser.location.hash}`) ?? legacyPath;
  if (!path) return false;
  browser.history.replaceState(browser.history.state, '', path);
  return true;
}

export function navigateWorkspace(path: string, options: { replace?: boolean } = {}, browser: WorkspaceBrowser = window): boolean {
  const target = new URL(path, browser.location.href);
  if (target.origin !== browser.location.origin || !isWorkspacePath(target.pathname)) return false;
  const destination = `${target.pathname}${target.search}${target.hash}`;
  if (destination === `${browser.location.pathname}${browser.location.search}${browser.location.hash}`) return true;
  if (options.replace) browser.history.replaceState(browser.history.state, '', destination);
  else browser.history.pushState(null, '', destination);
  browser.dispatchEvent(new Event(NAVIGATION_EVENT));
  return true;
}

type NavigationClick = Pick<MouseEvent, 'defaultPrevented' | 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;
interface NavigationLink { href: string; target?: string | null; download?: boolean; rel?: string | null }

/** Native browser behavior owns modified clicks, targets, downloads and anchors. */
export function workspaceNavigationTarget(event: NavigationClick, link: NavigationLink, currentHref: string): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    || link.target || link.download || link.rel?.split(/\s+/).includes('external') || !link.href || link.href.includes('#')) return null;
  let target: URL;
  try { target = new URL(link.href, currentHref); } catch { return null; }
  const current = new URL(currentHref);
  if (target.origin !== current.origin || target.hash || !isWorkspacePath(target.pathname)) return null;
  return `${target.pathname}${target.search}`;
}

/** One App subscription covers anchors and programmatic navigation, including Back/Forward. */
export function listenWorkspaceNavigation(onRoute: (route: WorkspaceRoute) => void, browser: WorkspaceBrowser = window): () => void {
  const sync = () => {
    canonicalizeWorkspaceLocation(browser);
    onRoute(readWorkspaceRoute(browser.location));
  };
  const onHashChange = () => {
    if (canonicalizeWorkspaceLocation(browser)) onRoute(readWorkspaceRoute(browser.location));
  };
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor) return;
    const path = workspaceNavigationTarget(event, {
      href: anchor.getAttribute('href') ?? '', target: anchor.getAttribute('target'),
      download: anchor.hasAttribute('download'), rel: anchor.getAttribute('rel'),
    }, browser.location.href);
    if (path === null) return;
    event.preventDefault();
    navigateWorkspace(path, {}, browser);
  };
  browser.addEventListener('popstate', sync);
  browser.addEventListener(NAVIGATION_EVENT, sync);
  browser.addEventListener('hashchange', onHashChange);
  browser.document.addEventListener('click', onClick);
  sync();
  return () => {
    browser.removeEventListener('popstate', sync);
    browser.removeEventListener(NAVIGATION_EVENT, sync);
    browser.removeEventListener('hashchange', onHashChange);
    browser.document.removeEventListener('click', onClick);
  };
}
