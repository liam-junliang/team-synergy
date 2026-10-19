import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  PUBLIC_CODE_BYTE_LENGTH,
  isPublicCode,
  publicCodeFromBytes,
} from '@team-synergy/contracts';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';

type CodeTable = { code: unknown; legacy_code?: unknown };

function trimIdentifier(value: string): string {
  return value.trim();
}

export function createPublicCode(): string {
  return publicCodeFromBytes(randomBytes(PUBLIC_CODE_BYTE_LENGTH));
}

export function isLegacyIdentifier(value: string): boolean {
  const identifier = trimIdentifier(value);
  return identifier.length > 0 && !isPublicCode(identifier);
}

export function codeCondition(table: CodeTable, identifier: string) {
  const value = trimIdentifier(identifier);
  if (!value) return undefined;
  if (isPublicCode(value) || table.legacy_code === undefined) {
    return eq(table.code as never, value);
  }
  return eq(table.legacy_code as never, value);
}

export async function findUserByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.users, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.users).where(condition).limit(1);
  return row;
}

export async function findTeamByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.teams, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.teams).where(condition).limit(1);
  return row;
}

export async function findProjectByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.projects, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.projects).where(condition).limit(1);
  return row;
}

export async function findFeatureByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.features, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.features).where(condition).limit(1);
  return row;
}

export async function findProjectModuleByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.projectModules, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.projectModules).where(condition).limit(1);
  return row;
}

export async function findProjectPhaseByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.projectPhases, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.projectPhases).where(condition).limit(1);
  return row;
}

export async function findProjectMilestoneByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.projectMilestones, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.projectMilestones).where(condition).limit(1);
  return row;
}

export async function findRequirementByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.requirements, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.requirements).where(condition).limit(1);
  return row;
}

export async function findRequirementDocumentByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.requirementDocuments, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.requirementDocuments).where(condition).limit(1);
  return row;
}

export async function findRequirementIdeaByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.requirementIdeas, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.requirementIdeas).where(condition).limit(1);
  return row;
}

export async function findRequirementTopicByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.requirementTopics, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.requirementTopics).where(condition).limit(1);
  return row;
}

export async function findProjectDocumentByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.projectDocuments, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.projectDocuments).where(condition).limit(1);
  return row;
}

export async function findProjectDocumentFolderByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.projectDocumentFolders, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.projectDocumentFolders).where(condition).limit(1);
  return row;
}

export async function findDesignPrototypeByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.designPrototypes, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.designPrototypes).where(condition).limit(1);
  return row;
}

export async function findTaskByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.tasks, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.tasks).where(condition).limit(1);
  return row;
}

export async function findDefectByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.defects, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.defects).where(condition).limit(1);
  return row;
}

export async function findRunByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.runs, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.runs).where(condition).limit(1);
  return row;
}

export async function findWorkspaceByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.workspaces, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.workspaces).where(condition).limit(1);
  return row;
}

export async function findDeviceByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.devices, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.devices).where(condition).limit(1);
  return row;
}

export async function findArtifactByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.artifacts, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.artifacts).where(condition).limit(1);
  return row;
}

export async function findEvidenceByCode(db: Db, identifier: string) {
  const condition = codeCondition(schema.evidences, identifier);
  if (!condition) return undefined;
  const [row] = await db.select().from(schema.evidences).where(condition).limit(1);
  return row;
}
