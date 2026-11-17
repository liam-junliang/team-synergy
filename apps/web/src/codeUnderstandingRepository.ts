import type { CodeRunSummary, CodeUnderstandingContext } from './codeUnderstandingApi';
import { resolveCodeSelection } from './codeUnderstandingMap.ts';
import { codeUnderstandingPath, type WorkspaceRoute } from './workspaceRouting.ts';

/** Resolve the repository before choosing a map, including links to older runs. */
export function resolveCodeRepositorySelection(context: CodeUnderstandingContext, route: WorkspaceRoute) {
  const viewCode = route.understandingView || (!route.understandingRun ? context.current_view : undefined);
  const view = context.views.find(item => item.code === viewCode);
  const explicitRun = context.runs.find(item => item.code === route.understandingRun);
  const repositoryCode = route.understandingRepository || (route.understandingRun ? explicitRun?.repository_code
    : view?.selections[0]?.repository_code || context.repositories[0]?.code);
  const repository = context.repositories.find(item => item.code === repositoryCode);
  const invalidRepository = Boolean(repositoryCode && !repository);
  const requestedRun = invalidRepository ? undefined : route.understandingRun
    || view?.selections.find(item => item.repository_code === repositoryCode)?.run_code;
  const selection = resolveCodeSelection(context, { ...route, understandingRepository: repositoryCode });
  return { ...selection, repository, repositoryCode, requestedRun,
    needsRun: Boolean(requestedRun && !context.runs.some(run => run.code === requestedRun)) };
}

/** A repository switch always opens its mainline; foreign run/node/view IDs drop. */
export function codeRepositoryPath(projectCode: string, repositoryCode: string) {
  return codeUnderstandingPath(projectCode, { repository: repositoryCode });
}

export interface CodeReaderState {
  scope: string;
  search: string;
  offset: number;
  direction: 'in' | 'out' | 'both';
  evidenceOpen: boolean;
}

/** Scope changes take effect during render, before any new query can use old state. */
export function codeReaderStateForScope(state: CodeReaderState | null, scope: string, node?: string): CodeReaderState {
  return state?.scope === scope ? state : { scope, search: '', offset: 0, direction: 'both', evidenceOpen: Boolean(node?.startsWith('cg:')) };
}

export function codeRunMatchesRepository(run: CodeRunSummary | undefined, runCode: string | undefined, repositoryCode: string | undefined) {
  return Boolean(run && run.code === runCode && run.repository_code === repositoryCode);
}
