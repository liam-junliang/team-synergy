/**
 * 品牌化类型：数据库内部用 bigint identity，外部 API/CLI/UI 只公开 20 位 code。
 * 运行时零开销；编译期区分内部主键与外部公开编码，避免跨实体误用。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type PublicCode = Brand<string, 'PublicCode'>;
export type NumericId = Brand<bigint, 'NumericId'>;

export type TeamId = Brand<bigint, 'TeamId'>;
export type TeamCode = Brand<string, 'TeamCode'>;
export type ProjectId = Brand<bigint, 'ProjectId'>;
export type ProjectCode = Brand<string, 'ProjectCode'>;
export type FeatureId = Brand<bigint, 'FeatureId'>;
export type FeatureCode = Brand<string, 'FeatureCode'>;
export type RequirementId = Brand<bigint, 'RequirementId'>;
export type RequirementCode = Brand<string, 'RequirementCode'>;
export type RequirementDocumentId = Brand<bigint, 'RequirementDocumentId'>;
export type RequirementDocumentCode = Brand<string, 'RequirementDocumentCode'>;
export type TaskId = Brand<bigint, 'TaskId'>;
export type TaskCode = Brand<string, 'TaskCode'>;
export type RunId = Brand<bigint, 'RunId'>;
export type RunCode = Brand<string, 'RunCode'>;
export type WorkspaceId = Brand<bigint, 'WorkspaceId'>;
export type WorkspaceCode = Brand<string, 'WorkspaceCode'>;
export type ArtifactId = Brand<bigint, 'ArtifactId'>;
export type ArtifactCode = Brand<string, 'ArtifactCode'>;
export type EvidenceId = Brand<bigint, 'EvidenceId'>;
export type EvidenceCode = Brand<string, 'EvidenceCode'>;
export type DefectId = Brand<bigint, 'DefectId'>;
export type DefectCode = Brand<string, 'DefectCode'>;
export type PrincipalId = Brand<bigint, 'PrincipalId'>;
export type PrincipalCode = Brand<string, 'PrincipalCode'>;
export type DeviceId = Brand<bigint, 'DeviceId'>;
export type DeviceCode = Brand<string, 'DeviceCode'>;
export type ClaimPolicyId = Brand<bigint, 'ClaimPolicyId'>;
