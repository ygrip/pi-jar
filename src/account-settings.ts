export const ACCOUNT_ROUTING_MODES = ["off", "sticky", "round-robin", "quota-first"] as const;
export type AccountRoutingMode = (typeof ACCOUNT_ROUTING_MODES)[number];
export interface AccountRoutingSettings {
  mode: AccountRoutingMode;
  /** Empty means every configured account; otherwise an explicit profile allowlist. */
  accounts: string[];
}
export const ACCOUNT_ROUTING_ENV = "PI_JAR_ACCOUNT_ROUTING";
export function validAccountName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}
export function parseAccountRouting(value: unknown): AccountRoutingSettings {
  const fallback: AccountRoutingSettings = { mode: "off", accounts: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const raw = value as Record<string, unknown>;
  if (!ACCOUNT_ROUTING_MODES.includes(raw.mode as AccountRoutingMode)) return fallback;
  if (!Array.isArray(raw.accounts) || raw.accounts.length > 128 || !raw.accounts.every(validAccountName)) return fallback;
  return { mode: raw.mode as AccountRoutingMode, accounts: [...new Set(raw.accounts)] };
}
