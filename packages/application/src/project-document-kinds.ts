export const PROJECT_DOCUMENT_KINDS = ['doc', 'api', 'diagram'] as const;
export type ProjectDocumentKind = (typeof PROJECT_DOCUMENT_KINDS)[number];
export const LEGACY_PROJECT_DOCUMENT_KINDS = ['general', 'integration', 'deployment', 'data', 'operations', 'release'] as const;
export type LegacyProjectDocumentKind = (typeof LEGACY_PROJECT_DOCUMENT_KINDS)[number];
export const PROJECT_DOCUMENT_INPUT_KINDS = [...PROJECT_DOCUMENT_KINDS, ...LEGACY_PROJECT_DOCUMENT_KINDS] as const;
export type ProjectDocumentInputKind = (typeof PROJECT_DOCUMENT_INPUT_KINDS)[number];

/** Keep historical purpose values in storage while exposing a stable content type. */
export function projectDocumentKindView(kind: ProjectDocumentInputKind) {
  return kind === 'api' || kind === 'diagram' || kind === 'doc'
    ? { kind }
    : { kind: 'doc' as const, legacy_kind: kind };
}
