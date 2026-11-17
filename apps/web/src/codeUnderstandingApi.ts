import { fetchEnvelope } from './api';
import type { CodeUnderstandingContext, CodeGraphResult, CodeGraphQuery, CodeRunSummary, CodeUaMapResult, CodeHostedAnalysisJobView, CodeHostedAnalysisRequest } from '../../../packages/contracts/src/code-understanding';

export type { CodeUnderstandingContext, CodeGraphResult, CodeRunSummary, CodeProjectView, CodeHostedAnalysisJobView } from '../../../packages/contracts/src/code-understanding';
export interface CodeAnalysisRuntime { configured: boolean; model: string | null; message: string }
const root = (project: string) => `/projects/${encodeURIComponent(project)}/code-understanding`;
export const getCodeUnderstandingContext = (project: string): Promise<CodeUnderstandingContext> => fetchEnvelope(`${root(project)}/context`);
export const getCodeUnderstandingRun = (project: string, run: string): Promise<CodeRunSummary> => fetchEnvelope(`${root(project)}/runs/${encodeURIComponent(run)}`);
export const getCodeUnderstandingUaMap = (project: string, run: string): Promise<CodeUaMapResult> => fetchEnvelope(`${root(project)}/runs/${encodeURIComponent(run)}/ua-map`);
export const getCodeAnalysisRuntime = (project: string): Promise<CodeAnalysisRuntime> => fetchEnvelope(`${root(project)}/runtime`);
export const listCodeAnalyses = (project: string): Promise<CodeHostedAnalysisJobView[]> => fetchEnvelope(`${root(project)}/analyses`);
export const getCodeAnalysis = (project: string, job: string): Promise<CodeHostedAnalysisJobView> => fetchEnvelope(`${root(project)}/analyses/${encodeURIComponent(job)}`);
export const requestCodeAnalysis = (project: string, input: CodeHostedAnalysisRequest): Promise<CodeHostedAnalysisJobView[]> => fetchEnvelope(`${root(project)}/analyses`, { method: 'POST', body: JSON.stringify(input) });
export function getCodeUnderstandingGraph(project: string, query: Partial<CodeGraphQuery>): Promise<CodeGraphResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  return fetchEnvelope(`${root(project)}/graph?${params}`);
}
