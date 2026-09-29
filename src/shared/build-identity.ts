/** Deployment metadata only; never source paths, branch names, or file contents. */
export interface BuildSourceIdentity {
  revision: string | null;
  worktree: 'clean' | 'dirty' | 'unknown';
}
export interface BuildIdentity extends BuildSourceIdentity {
  buildId: string | null;
}
export function sanitizeBuildIdentity(value: unknown): BuildIdentity {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const revision =
    typeof input.revision === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.revision)
      ? input.revision.toLowerCase()
      : null;
  return {
    buildId:
      typeof input.buildId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.buildId)
        ? input.buildId
        : null,
    revision,
    worktree:
      revision && (input.worktree === 'clean' || input.worktree === 'dirty')
        ? (input.worktree as 'clean' | 'dirty')
        : 'unknown',
  };
}
