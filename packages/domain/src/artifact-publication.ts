import { DomainError } from './errors.js';
import type { ArtifactCode } from '@team-synergy/contracts';

/**
 * 架构不变量 4：Artifact 必须显式发布；未发布文件不属于项目状态。
 */
export interface ArtifactState {
  artifact_code: ArtifactCode;
  published: boolean;
  uri: string;
}

/** 判定该 Artifact 是否属于项目共同状态 */
export function isProjectStateArtifact(artifact: ArtifactState): boolean {
  return artifact.published && artifact.uri.length > 0;
}

export function assertExplicitPublication(artifact: ArtifactState): void {
  if (!isProjectStateArtifact(artifact)) {
    throw new DomainError('artifact_not_published', 'Artifact 必须显式发布才属于项目状态（架构不变量 4）', {
      artifact_code: artifact.artifact_code,
    });
  }
}
