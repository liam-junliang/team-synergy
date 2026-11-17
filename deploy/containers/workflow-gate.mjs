import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function deploymentGate({ eventName, event, repository, ref, sha, api }) {
  if (eventName === 'pull_request') return { build: true, publish: false, sha };
  const run = eventName === 'workflow_run' ? event.workflow_run : null;
  if (eventName === 'workflow_run' && (run?.conclusion !== 'success' || run.event !== 'push' || run.head_branch !== 'main' || run.head_repository?.full_name !== repository)) return { build: false, publish: false };
  if (!['workflow_run', 'workflow_dispatch'].includes(eventName) || (eventName === 'workflow_dispatch' && ref !== 'refs/heads/main')) return { build: false, publish: false };
  const candidate = run?.head_sha ?? sha;
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw Error('Invalid source revision');
  const main = await api(`/repos/${repository}/git/ref/heads/main`);
  if (main.object.sha !== candidate) return { build: false, publish: false };
  const checks = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${candidate}&branch=main&event=push&status=success&per_page=10`);
  const verified = checks.workflow_runs.some(check => check.head_sha === candidate && check.conclusion === 'success' && check.event === 'push' && check.head_branch === 'main' && check.head_repository?.full_name === repository);
  return { build: verified, publish: verified, sha: candidate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GITHUB_TOKEN;
  const api = async route => {
    const response = await fetch(`https://api.github.com${route}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error(`GitHub verification failed (${response.status})`);
    return response.json();
  };
  const result = await deploymentGate({ eventName: process.env.GITHUB_EVENT_NAME, event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, api });
  appendFileSync(process.env.GITHUB_OUTPUT, `build=${result.build}\npublish=${result.publish}\nsha=${result.sha ?? ''}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.build ? (result.publish ? 'Current main has exact successful CI; container build may proceed.\n' : 'PR preview build only; publication and deployment are disabled.\n') : 'Candidate is not current verified main; no images published and no deployment.\n');
  process.stdout.write(JSON.stringify({ build: result.build, publish: result.publish, sha: result.sha }) + '\n');
}
