import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Activate or deactivate one registered tool. Inactive tools send neither their schema nor their
 * prompt rules, so mode-specific tools are active only while their mode is. Pi applies a change
 * made in before_agent_start to that run; toggling only at mode boundaries keeps the prompt stable.
 */
export function setToolActive(pi: ExtensionAPI, name: string, wanted: boolean): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const active = pi.getActiveTools();
  const has = active.includes(name);
  if (wanted && !has && pi.getAllTools().some((tool) => tool.name === name)) pi.setActiveTools([...active, name]);
  else if (!wanted && has) pi.setActiveTools(active.filter((tool) => tool !== name));
}
