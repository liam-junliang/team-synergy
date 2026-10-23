import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const activeRuns = new Set<string>();
const runName = /^draft-[A-Za-z0-9]{6}$/;
const staleMs = 24 * 60 * 60 * 1000;
const within = (parent: string, child: string) => { const part = relative(parent, child); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function metadata(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch { return undefined; }
}
function alive(pid: unknown) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Only this dedicated root's direct, recognized run directories may be removed. */
export function createRunDirectoryStore(directory: string, keep: number) {
  const root = resolve(directory);
  async function safeRoot(create = false) {
    if (!isAbsolute(directory) || within(root, resolve(process.cwd())) || within(resolve(process.cwd()), root)) throw new Error('Unsafe system Agent directory.');
    // Refuse junction/symlink ancestors as well as a symlink root.
    for (let part = root;; part = dirname(part)) {
      try { if ((await lstat(part)).isSymbolicLink()) throw new Error('Unsafe system Agent directory.'); }
      catch (error) { if (!missing(error)) throw error; }
      if (dirname(part) === part) break;
    }
    if (create) await mkdir(root, { recursive: true });
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(root), root)) throw new Error('Unsafe system Agent directory.');
      return true;
    } catch (error) { if (missing(error)) return false; throw error; }
  }
  async function safeRun(path: string) {
    if (!samePath(dirname(path), root) || !runName.test(path.slice(root.length + 1)) || !await safeRoot()) return false;
    try { const stat = await lstat(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  async function legacyRun(path: string) {
    const required = ['home', 'workspace', 'tmp', 'no-tools.mjs', 'document-draft.patch.yml'];
    for (const name of required) {
      try { if ((await lstat(join(path, name))).isSymbolicLink()) return false; }
      catch { return false; }
    }
    return true;
  }
  async function cleanup() {
    if (!await safeRoot()) return;
    const retained: { path: string; completed: string }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !runName.test(entry.name) || activeRuns.has(path) || !await safeRun(path)) continue;
      const owner = await metadata(join(path, 'owner.json'));
      if (alive(owner?.pid) || alive(owner?.child_pid)) continue;
      const failure = await metadata(join(path, 'failure.json'));
      const owned = owner?.version === 1 && typeof owner.pid === 'number';
      const retainedFailure = failure?.version === 1 && typeof failure.completed_at === 'string';
      if (!owned && !retainedFailure && !await legacyRun(path)) continue;
      if (Date.now() - (await lstat(path)).mtimeMs > staleMs) {
        if (await safeRun(path)) await rm(path, { recursive: true, force: true });
      } else if (retainedFailure) retained.push({ path, completed: String(failure.completed_at) });
    }
    retained.sort((a, b) => b.completed.localeCompare(a.completed) || b.path.localeCompare(a.path));
    for (const item of retained.slice(keep)) if (!activeRuns.has(item.path) && await safeRun(item.path)) await rm(item.path, { recursive: true, force: true });
  }
  return {
    cleanup,
    async begin() {
      await safeRoot(true);
      const path = await mkdtemp(join(root, 'draft-'));
      activeRuns.add(path);
      try { await writeFile(join(path, 'owner.json'), JSON.stringify({ version: 1, pid: process.pid })); }
      catch (error) { activeRuns.delete(path); if (await safeRun(path)) await rm(path, { recursive: true, force: true }); throw error; }
      return path;
    },
    async child(path: string, pid: number | undefined) {
      if (!activeRuns.has(path) || !await safeRun(path)) throw new Error('Unsafe system Agent directory.');
      await writeFile(join(path, 'owner.json'), JSON.stringify({ version: 1, pid: process.pid, child_pid: pid }));
    },
    async finish(path: string, failureCode?: string) {
      try {
        if (!activeRuns.has(path) || !await safeRun(path)) throw new Error('Unsafe system Agent directory.');
        // Engine sessions, stderr and workspace contents are never retained.
        await rm(path, { recursive: true, force: true });
        if (failureCode && keep > 0) {
          await safeRoot();
          await mkdir(path);
          await writeFile(join(path, 'failure.json'), JSON.stringify({ version: 1, code: failureCode, completed_at: new Date().toISOString() }));
        }
      } finally { activeRuns.delete(path); }
      await cleanup();
    },
  };
}
