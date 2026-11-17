import { DomainError } from '@team-synergy/domain';
import { PersonalMemoryEditInput, PersonalMemoryListQuery, PersonalMemoryWithdrawInput, PublicCodeSchema,
  type PersonalMemoryListView, type PersonalMemoryView } from '@team-synergy/contracts';
import { valueOf, type personalMemoryContext } from './memory.js';

type Context = Pick<ReturnType<typeof personalMemoryContext>, 'client' | 'route'>;
const invalidInput = () => new DomainError('memory_personal_invalid_input', '请提供有效的本人记忆编码、当前revision、正文及可选理由。');
const invalidView = () => new DomainError('memory_personal_invalid_response', '平台返回的个人记忆版本或生命周期状态无效。');
const sourcePath = (context: Context, source: unknown) => {
  const parsed = PublicCodeSchema.safeParse(source);
  if (!parsed.success) throw invalidInput();
  return context.route + '/' + encodeURIComponent(parsed.data);
};

function view(value: unknown, expectedSource?: string): PersonalMemoryView {
  const row = value as PersonalMemoryView | null;
  if (!row || typeof row !== 'object' || !PublicCodeSchema.safeParse(row.source).success ||
      !PublicCodeSchema.safeParse(row.revisionSource).success || (expectedSource && row.source !== expectedSource) ||
      !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.text !== 'string' || row.text.length > 4000 ||
      !['active', 'withdrawn'].includes(row.status) || !['account', 'project'].includes(row.applicability) ||
      !PublicCodeSchema.safeParse(row.projectCode).success || !row.provenance || !row.projection || !Array.isArray(row.history) ||
      !['not_queued', 'pending', 'processing', 'synced', 'needs_reconcile'].includes(row.projection.status) ||
      !['upsert', 'delete'].includes(row.projection.operation) || typeof row.projection.cleanupPending !== 'boolean') throw invalidView();
  return row;
}

export async function listPersonalMemory(context: Context, input: unknown = {}): Promise<PersonalMemoryListView> {
  const parsed = PersonalMemoryListQuery.safeParse(input);
  if (!parsed.success) throw invalidInput();
  const query = new URLSearchParams();
  if (parsed.data.projectCode) query.set('projectCode', parsed.data.projectCode);
  if (parsed.data.status) query.set('status', parsed.data.status);
  const result = valueOf(await context.client.request<PersonalMemoryListView>('GET', context.route + (query.size ? '?' + query : '')));
  if (!result || !Array.isArray(result.items) || typeof result.truncated !== 'boolean') throw invalidView();
  for (const row of result.items) view(row);
  return result;
}

export async function readPersonalMemory(context: Context, source: string) {
  return view(valueOf(await context.client.request<PersonalMemoryView>('GET', sourcePath(context, source))), source);
}

export async function editPersonalMemory(context: Context, source: string, input: unknown) {
  const parsed = PersonalMemoryEditInput.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return view(valueOf(await context.client.request<PersonalMemoryView>('PATCH', sourcePath(context, source), parsed.data)), source);
}

export async function withdrawPersonalMemory(context: Context, source: string, input: unknown) {
  const parsed = PersonalMemoryWithdrawInput.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return view(valueOf(await context.client.request<PersonalMemoryView>('POST', sourcePath(context, source) + '/withdraw', parsed.data)), source);
}
