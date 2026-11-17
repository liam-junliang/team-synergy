import { objectRecord, semanticDigest, semanticInvalid } from './code-analysis-semantic-source.js';

export const CLAIM_BINDING_PROTOCOL = 'raw-claim-shared-assignment-1.0.0';
export const CLAIM_BINDING_MAX_TEXT_LENGTH = 20_000;
export const CLAIM_BINDING_MAX_BINDINGS = 64;

export interface ClaimBindingSpan { start: number; end: number; raw: string }
export type ClaimBindingSkipReason = 'quoted_or_code_data' | 'polarity_modality_or_question' | 'separate_or_ordered_mapping' | 'ambiguous_or_invalid_target_list' | 'ambiguous_or_missing_value';
export interface ClaimBinding {
  id: string; protocol: typeof CLAIM_BINDING_PROTOCOL; text_sha256: string;
  clause: ClaimBindingSpan; assignment: ClaimBindingSpan; target: ClaimBindingSpan;
  operator: ClaimBindingSpan; value: ClaimBindingSpan;
  interpretation: 'raw_claim_fragment_in_original_whole_scope_not_an_independent_fact';
}
export interface ClaimBindingPlan {
  protocol: typeof CLAIM_BINDING_PROTOCOL; text_sha256: string; bindings: ClaimBinding[];
  coverage: { parsed_groups: number; bindings: number; skipped: { start: number; end: number; reason: ClaimBindingSkipReason }[] };
  mandatory_whole_claim_check: true;
  source_facts_approved: false;
}

const identifier = /^[\p{L}_$][\p{L}\p{N}_$]*(?:(?:\.[\p{L}_$][\p{L}\p{N}_$]*)|(?:\[\d+\]))*$/u;
const bareValue = /^[A-Za-z_$][\w$]*(?:(?:[./][A-Za-z_$][\w$]*)|(?:\[\d+\]))*$/u;
const number = /^[+-]?(?:(?:\d+(?:\.\d+)?)|(?:0x[\da-f]+))$/iu;
const ambiguousTargets = /分别|各自|对应|依次|逐一|以及|与|和|及|把|将|不|未|勿|别/u;
const modality = /不能|不可|不得|不要|不应|禁止|不允许|不会|尚未|未曾|没有|并非|计划|准备|打算|希望|建议|拟|将来|将要|预期|预计|期望|应当|应该|必须|需要|须要|假如|如果|假设|倘若|要是|除非|只要|只有|否则|(?:^|\s)若|是否|能否|可否|要不要|能不能|请|麻烦|帮我|示例|样例|举例|引用|原话|讨论|设想/u;
const quotes = new Map<string, string>([['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’']]);
const fail = (reason: string): never => semanticInvalid(reason, false);

// UTF16 masks preserve the exact indices used by the raw source claim.
function quoteMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length); let delimiter: string | null = null, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (delimiter) {
      mask[index] = 1;
      if (delimiter === '```' && text.startsWith('```', index)) { mask.fill(1, index, index + 3); index += 2; delimiter = null; }
      else if (delimiter !== '```') {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === delimiter) delimiter = null;
      }
    } else if (text.startsWith('```', index)) { mask.fill(1, index, index + 3); index += 2; delimiter = '```'; }
    else if (quotes.has(character)) { mask[index] = 1; delimiter = quotes.get(character) ?? null; }
  }
  return mask;
}
function boundary(text: string, index: number, mask: Uint8Array): boolean {
  const character = text.charAt(index);
  return !mask[index] && ('，,。；;\n？！?!'.includes(character) || character === '.' && (index + 1 === text.length || /\s/u.test(text.charAt(index + 1))));
}
function trimmedRange(text: string, start: number, end: number): ClaimBindingSpan {
  while (start < end && /\s/u.test(text.charAt(start))) start++;
  while (end > start && /\s/u.test(text.charAt(end - 1))) end--;
  return { start, end, raw: text.slice(start, end) };
}
function singleValue(raw: string): boolean {
  if (bareValue.test(raw) || number.test(raw)) return true;
  const close = quotes.get(raw.charAt(0));
  if (!close || raw.length < 2 || raw.at(-1) !== close || /[\r\n]/u.test(raw)) return false;
  let escaped = false;
  for (let index = 1; index < raw.length - 1; index++) {
    if (escaped) escaped = false;
    else if (raw.charAt(index) === '\\') escaped = true;
    else if (raw.charAt(index) === close) return false;
  }
  return !escaped;
}
function targetIdentifier(raw: string): boolean {
  const value = raw.startsWith('`') && raw.endsWith('`') ? raw.slice(1, -1) : raw;
  return identifier.test(value) && !ambiguousTargets.test(value);
}
function assertSpan(text: string, span: ClaimBindingSpan): void {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length || text.slice(span.start, span.end) !== span.raw) fail('claim_binding_span_identity');
}

/**
 * Extracts conservative surface bindings, never source facts or permission.
 * Every tuple remains data in the unchanged whole claim and original scope.
 * Unsupported syntax is explicit coverage loss; even a fully parsed tuple list
 * cannot replace the mandatory independent whole-claim/source check.
 */
export function parseClaimBindings(text: string): ClaimBindingPlan {
  if (typeof text !== 'string' || text.length > CLAIM_BINDING_MAX_TEXT_LENGTH) fail('claim_binding_text_budget');
  const text_sha256 = semanticDigest(text), mask = quoteMask(text), bindings: ClaimBinding[] = [], skipped: ClaimBindingPlan['coverage']['skipped'] = [];
  let consumedUntil = -1, parsedGroups = 0;
  for (const match of text.matchAll(/[把将]/gu)) {
    const at = match.index;
    if (at === undefined) return fail('claim_binding_match_identity');
    if (at < consumedUntil) continue;
    if (mask[at]) { skipped.push({ start: at, end: at + 1, reason: 'quoted_or_code_data' }); continue; }
    let start = at, end = at + 1;
    while (start > 0 && !boundary(text, start - 1, mask)) start--;
    while (end < text.length && !boundary(text, end, mask)) end++;
    const operator = /设置为|设为/u.exec(text.slice(at + 1, end));
    if (!operator) continue;
    const operatorText = operator[0];
    if (!operatorText) return fail('claim_binding_match_identity');
    consumedUntil = end;
    const operatorStart = at + 1 + operator.index, operatorEnd = operatorStart + operatorText.length;
    const clause = trimmedRange(text, start, end);
    let sentenceStart = start;
    while (sentenceStart > 0 && !(!mask[sentenceStart - 1] && '。；;\n？！?!'.includes(text.charAt(sentenceStart - 1)))) sentenceStart--;
    const prefix = text.slice(sentenceStart, at);
    const skip = (reason: ClaimBindingSkipReason): void => { skipped.push({ start: clause.start, end: clause.end, reason }); };
    if (mask[operatorStart] || modality.test(prefix) || /不|未|勿|若|(?<!分)别/u.test(prefix) || /当[^。；;\n]*(?:时|后|则|，|,)/u.test(prefix) || /[?？]/u.test(text.charAt(end)) || /[吗么吧]/u.test(clause.raw)) { skip('polarity_modality_or_question'); continue; }
    const targetRange = trimmedRange(text, at + 1, operatorStart), value = trimmedRange(text, operatorEnd, end);
    if (/分别|各自|对应|依次|逐一/u.test(targetRange.raw)) { skip('separate_or_ordered_mapping'); continue; }
    const targets = targetRange.raw.split('、').map(raw => raw.trim());
    if (!targets.length || targets.some(raw => !targetIdentifier(raw)) || new Set(targets).size !== targets.length) { skip('ambiguous_or_invalid_target_list'); continue; }
    if (!value.raw || !singleValue(value.raw)) { skip('ambiguous_or_missing_value'); continue; }
    const assignment = { start: at, end: value.end, raw: text.slice(at, value.end) };
    let cursor = targetRange.start;
    for (const raw of targets) {
      const targetStart = text.indexOf(raw, cursor); cursor = targetStart + raw.length;
      const target = { start: targetStart, end: cursor, raw };
      const identity: Omit<ClaimBinding, 'id' | 'interpretation'> = { protocol: CLAIM_BINDING_PROTOCOL, text_sha256, clause, assignment, target, operator: { start: operatorStart, end: operatorEnd, raw: operatorText }, value };
      for (const span of [identity.clause, identity.assignment, identity.target, identity.operator, identity.value]) assertSpan(text, span);
      bindings.push({ id: 'CB-' + semanticDigest(identity).slice(0, 24), ...identity, interpretation: 'raw_claim_fragment_in_original_whole_scope_not_an_independent_fact' });
      if (bindings.length > CLAIM_BINDING_MAX_BINDINGS) fail('claim_binding_count_budget');
    }
    parsedGroups++;
  }
  return { protocol: CLAIM_BINDING_PROTOCOL, text_sha256, bindings, coverage: { parsed_groups: parsedGroups, bindings: bindings.length, skipped }, mandatory_whole_claim_check: true, source_facts_approved: false };
}

/** Recompute the entire host plan; response tuples cannot supply or drop views. */
export function assertClaimBindingPlan(text: string, proposed: unknown): ClaimBindingPlan {
  const actual = parseClaimBindings(text);
  if (!objectRecord(proposed)) return fail('claim_binding_plan_forged');
  let proposed_sha256: string;
  try { proposed_sha256 = semanticDigest(proposed); } catch { return fail('claim_binding_plan_forged'); }
  if (semanticDigest(actual) !== proposed_sha256) return fail('claim_binding_plan_forged');
  return actual;
}
