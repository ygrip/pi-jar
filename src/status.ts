import type { RoleStatus, RoleState } from "./roles.ts";

export const ROLE_PREFIX = "pi-jar.role.";
export const ACTIVE_STATES = new Set<RoleState>(["thinking", "working", "reviewing"]);
export const ROLE_TTL_MS = 30_000;
const STATES = new Set<RoleState>(["idle", "thinking", "working", "waiting", "reviewing", "done", "failed"]);

/** Remove terminal controls from third-party status text before placing it in our footer. */
export function cleanText(value: string, limit = 72): string {
  return value.slice(0, 4096)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export interface JarRole extends RoleStatus {
  expiresAt?: number;
}

export interface JarStatus {
  roles: JarRole[];
  extras: string[];
}

/** Explicit opt-in contract; never guess teammate state from arbitrary status prose. */
export function collectStatuses(statuses: ReadonlyMap<string, string>, now: number): JarStatus {
  const roles: JarRole[] = [];
  const extras: string[] = [];
  for (const [rawKey, rawValue] of statuses) {
    const key = cleanText(rawKey, 48);
    if (!key || typeof rawValue !== "string") continue;
    if (rawKey.startsWith("pi-jar.quota.")) continue;
    if (!rawKey.startsWith(ROLE_PREFIX)) {
      const value = cleanText(rawValue);
      if (value) extras.push(`${key}: ${value}`);
      continue;
    }
    const id = rawKey.slice(ROLE_PREFIX.length);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) continue;
    try {
      if (rawValue.length > 4096) throw new Error("oversized status");
      const data: unknown = JSON.parse(rawValue);
      if (!data || typeof data !== "object") throw new Error("invalid status");
      const role = data as Record<string, unknown>;
      if (typeof role.name !== "string" || typeof role.state !== "string" || !STATES.has(role.state as RoleState)) {
        throw new Error("invalid role");
      }
      const state = role.state as RoleState;
      const expiresAt = role.expiresAt;
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + ROLE_TTL_MS) {
        extras.push(`${id}: unavailable`);
        continue;
      }
      const name = cleanText(role.name, 32) || id;
      roles.push({
        id,
        name,
        label: cleanText(typeof role.label === "string" ? role.label : name, 12) || id,
        state,
        task: typeof role.task === "string" ? cleanText(role.task, 48) : undefined,
        expiresAt: typeof expiresAt === "number" ? expiresAt : undefined
      });
    } catch {
      extras.push(`${id}: unavailable`);
    }
  }
  return { roles: roles.slice(0, 16), extras: extras.slice(0, 16) };
}
