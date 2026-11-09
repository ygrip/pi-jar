export const ACCOUNT_ROUTING_MODES = ["off", "sticky", "round-robin", "quota-first"] as const;
export type AccountRoutingMode = (typeof ACCOUNT_ROUTING_MODES)[number];
export interface AccountRoutingSettings {
  mode: AccountRoutingMode;
  /** Empty means every configured account; otherwise an explicit profile allowlist. */
  accounts: string[];
  /** Optional per-provider pin. With no pin, the provider's own account pool follows mode. */
  pinned?: Record<string, string>;
  /** Set only by unsafeAccountRouting(): why the configured policy could not be trusted. Requests are refused. */
  invalid?: string;
}
export const ACCOUNT_ROUTING_ENV = "PI_JAR_ACCOUNT_ROUTING";
export function validAccountName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}
export function validProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}
const MAX_REASON_CHARS = 200;

/**
 * A routing policy that is present but cannot be trusted. `mode` is not "off" so every code path
 * treats routing as active, and `invalid` makes the router refuse every request: "off" means
 * "use Pi's own login", which a restricted-but-corrupt policy must never fall back to.
 */
export function unsafeAccountRouting(reason: string): AccountRoutingSettings {
  // The reason is a tag, not just text: it is always non-empty, so "present" and "truthy" can never differ.
  return { mode: "sticky", accounts: [], invalid: reason.trim().slice(0, MAX_REASON_CHARS) || "unspecified reason" };
}

/** Test for the tag with `!== undefined`, never truthiness: an empty or non-string marker is still a lock. */
export function isUnsafeRouting(policy: AccountRoutingSettings): boolean {
  return policy.invalid !== undefined;
}

/** An explicit user choice of mode. It replaces an unsafe policy outright instead of inheriting its bad fields. */
export function withRoutingMode(policy: AccountRoutingSettings, mode: AccountRoutingMode): AccountRoutingSettings {
  if (isUnsafeRouting(policy)) return { mode, accounts: [] };
  return { ...policy, mode };
}

/**
 * Only a genuinely absent value (a profile or settings file from before account routing existed)
 * means "off". Anything present but malformed becomes an unsafe policy, never a silent "off".
 */
export function parseAccountRouting(value: unknown): AccountRoutingSettings {
  if (value === undefined) return { mode: "off", accounts: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unsafeAccountRouting("account routing settings are not an object");
  const raw = value as Record<string, unknown>;
  if (raw.invalid !== undefined) {
    // A stored marker stays a lock. A malformed one (empty, null, wrong type) is itself a reason to lock.
    if (typeof raw.invalid === "string" && raw.invalid.trim()) return unsafeAccountRouting(raw.invalid);
    return unsafeAccountRouting("stored routing lock is malformed");
  }
  if (!ACCOUNT_ROUTING_MODES.includes(raw.mode as AccountRoutingMode)) return unsafeAccountRouting("account routing mode is not recognised");
  if (!Array.isArray(raw.accounts) || raw.accounts.length > 128 || !raw.accounts.every(validAccountName)) {
    return unsafeAccountRouting("account routing allowlist is malformed");
  }
  const result: AccountRoutingSettings = { mode: raw.mode as AccountRoutingMode, accounts: [...new Set(raw.accounts)] };
  if (raw.pinned !== undefined) {
    if (!raw.pinned || typeof raw.pinned !== "object" || Array.isArray(raw.pinned)) return unsafeAccountRouting("pinned accounts are malformed");
    const entries = Object.entries(raw.pinned);
    if (entries.length > 128 || !entries.every(([provider, name]) => validProviderId(provider) && validAccountName(name))) {
      return unsafeAccountRouting("pinned accounts are malformed");
    }
    if (entries.length) result.pinned = Object.fromEntries(entries) as Record<string, string>;
  }
  return result;
}
