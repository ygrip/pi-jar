import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionManagerLike = ExtensionContext["sessionManager"] & { getLeafId?: () => string | null | undefined };
const cache = new WeakMap<object, { leaf: string; branch: readonly unknown[] }>();

/**
 * Pi's getBranch() walks leaf → root and reverses a new array every call. Reuse that projection
 * across pi-jar features while the leaf id is unchanged; a new session entry naturally changes
 * the leaf and invalidates the cache.
 */
export function sessionBranch(ctx: Pick<ExtensionContext, "sessionManager">): readonly unknown[] {
  const manager = ctx.sessionManager as SessionManagerLike;
  const leaf = manager.getLeafId?.();
  if (!leaf) return manager.getBranch();
  const hit = cache.get(manager as object);
  if (hit?.leaf === leaf) return hit.branch;
  const branch = manager.getBranch();
  cache.set(manager as object, { leaf, branch });
  return branch;
}

export function clearSessionBranchCache(ctx: Pick<ExtensionContext, "sessionManager">): void {
  cache.delete(ctx.sessionManager as object);
}
