export type SkillScope = 'team' | 'project';
export interface SkillFile { path: string; content_base64: string; size_bytes: number; sha256: string }
export interface SkillFileInput { path: string; content_base64: string; size_bytes?: number; sha256?: string }
/** Hash is SHA-256 of JSON.stringify(sorted files.map(f => [f.path, f.sha256, f.size_bytes])). */
export interface SkillPackage { name: string; description: string; files: SkillFile[]; package_sha256: string; size_bytes: number }
export interface SkillRevision extends SkillPackage { revision: number; change_summary: string; created_at: string; created_by_user_code: string; published_at: string | null }
export interface SkillSummary {
  code: string; scope_type: SkillScope; scope_code: string; name: string; description: string;
  current_revision: number; published_revision: number | null; archived: boolean; updated_at: string;
  owner_user_code: string; can_edit: boolean; can_manage: boolean; available_revisions: number[];
}
export interface SkillShare {
  code: string; target_type: SkillScope; target_code: string; revisions: number[]; allow_projects: boolean;
  allow_external: boolean; created_at: string; revoked_at: string | null;
}
export interface SkillDetail extends SkillSummary { revisions: SkillRevision[]; shares: SkillShare[] }
export interface SkillCreateInput { scope_type: SkillScope; scope_code: string; files: SkillFileInput[]; change_summary?: string }
export interface SkillReviseInput { base_revision: number; files: SkillFileInput[]; change_summary: string }
export interface SkillShareInput { target_type: SkillScope; target_code: string; revisions: number[]; allow_projects?: boolean; allow_external?: boolean }
export interface SkillInstallInput { revision: number; alias: string; enabled: boolean; base_generation: number }
export interface ProjectSkillInstallation {
  skill_code: string; revision: number; alias: string; enabled: boolean; name: string; description: string;
  scope_type: SkillScope; scope_code: string; package_sha256: string; available_revisions: number[];
  blocked: boolean; blocked_reason: string | null;
}
export interface ProjectSkills { project_code: string; generation: number; can_manage: boolean; installations: ProjectSkillInstallation[] }
export interface SkillManifestEntry { skill_code: string; revision: number; alias: string; name: string; description: string; scope_type: SkillScope; scope_code: string; package_sha256: string }
/** Metadata only: safe to retain in Run history. Download must check current grants again. */
export interface RunSkillManifest { project_code: string; generation: number; skills: SkillManifestEntry[] }
export interface ProjectSkillManifest extends RunSkillManifest { skills: Array<SkillManifestEntry & { files: SkillFile[] }> }
