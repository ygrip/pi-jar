/** How one hidden workflow message type is projected into provider context. */
export interface WorkflowMessageRule {
  /** False drops every message of this type (its mode is off). */
  keep: boolean;
  /** Drop a message whose content repeats the previously kept one of the same type. */
  dedupe?: boolean;
}

/**
 * Provider-context projection for hidden workflow prompts (plan/goal context, reminders,
 * continuations). Pi caches the conversation prefix, so a message once sent must keep being sent:
 * every keep/drop decision depends only on the messages before it, never on later ones. Dropping
 * an older copy when a newer one arrives would change the prefix and re-bill the whole previous
 * run uncached. Returns undefined when nothing changes.
 */
export function projectWorkflowMessages<T>(messages: T[], rules: Readonly<Record<string, WorkflowMessageRule>>): T[] | undefined {
  const last = new Map<string, string>();
  let projected: T[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const type = (message as { customType?: string }).customType;
    const rule = type === undefined ? undefined : rules[type];
    let keep = true;
    if (rule) {
      if (!rule.keep) keep = false;
      else if (rule.dedupe) {
        const raw = (message as { content?: unknown }).content;
        const content = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
        if (last.get(type!) === content) keep = false;
        else last.set(type!, content);
      }
    }
    if (!keep) projected ??= messages.slice(0, index);
    else projected?.push(message);
  }
  return projected;
}
