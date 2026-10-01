export const FOOTER_FIELDS = ["model", "effort", "sessionName", "cwd", "context", "memory", "cost", "quota", "roles", "extras", "branch"] as const;
export type FooterField = (typeof FOOTER_FIELDS)[number];
export type FooterSettings = Record<FooterField, boolean>;
export const DEFAULT_FOOTER_SETTINGS: FooterSettings = Object.fromEntries(
  FOOTER_FIELDS.map((field) => [field, true])
) as FooterSettings;
