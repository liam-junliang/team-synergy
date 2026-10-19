import { ensureProjectSystemFolder, PROJECT_SYSTEM_FOLDER_NAMES, type ProjectSystemFolderRole } from './project-document-folders.js';

export const PROJECT_STANDARDS_FOLDER_NAME = PROJECT_SYSTEM_FOLDER_NAMES.standards;

export interface FolderMembership {
  id: bigint;
  project_id: bigint;
  parent_id: bigint | null;
  system_role: ProjectSystemFolderRole | null;
  status: string;
}

interface StandardsDocument {
  id: bigint;
  project_id: bigint;
  folder_id: bigint | null;
  status: string;
  title: string;
  code: string;
}

/** Shared by live home views and frozen Agent Context Pack compilation. */
export function collectProjectStandardsDocuments<T extends StandardsDocument>(
  projectId: bigint,
  folders: readonly FolderMembership[],
  documents: readonly T[],
): T[] {
  const activeFolders = folders.filter(folder => folder.project_id === projectId && folder.status === 'active');
  const root = activeFolders.find(folder => folder.system_role === 'standards' && folder.parent_id === null);
  if (!root) return [];
  const included = new Set([root.id]);
  // Following only active parents excludes entire archived branches. The set
  // also prevents malformed cycles from making traversal non-terminating.
  for (let size = 0; size !== included.size;) {
    size = included.size;
    for (const folder of activeFolders) {
      if (folder.parent_id !== null && included.has(folder.parent_id)) included.add(folder.id);
    }
  }
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  return documents.filter(document => document.project_id === projectId && document.status === 'active'
    && document.folder_id !== null && included.has(document.folder_id))
    .sort((left, right) => compare(left.title, right.title) || compare(left.code, right.code));
}

/** Must run inside the caller's transaction, after project membership is checked. */
export async function ensureProjectStandardsFolder(tx: Parameters<typeof ensureProjectSystemFolder>[0], projectId: bigint) {
  return ensureProjectSystemFolder(tx, projectId, 'standards');
}
