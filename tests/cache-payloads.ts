/** Provider payload builders shared by the cache-break tests. */

export interface Block { type: string; [key: string]: unknown }
export interface Message { role: string; content: string | Block[] }
export interface Tool { name: string; description: string; input_schema: { type: string; properties: object; required: string[] } }

/** What Pi assembles: a preamble, then named sections. */
export const SYSTEM = (skills = "deploy: ship it") =>
  ["You are an expert coding assistant operating inside pi.", "<tools>\n\n- read: Read a file\n\n</tools>", `<skills>\n\n${skills}\n\n</skills>`, "<cwd>\n\n/repo\n\n</cwd>"].join("\n\n");

export const tool = (name: string, description = `${name} tool`): Tool => ({ name, description, input_schema: { type: "object", properties: {}, required: [] } });
export const user = (text: string): Message => ({ role: "user", content: text });
export const call = (id: string, name: string): Message => ({ role: "assistant", content: [{ type: "text", text: `running ${name}` }, { type: "tool_use", id, name, input: { path: "src/a.ts" } }] });
export const result = (id: string, text: string): Message => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });
export const reply = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

/** Like Pi's Anthropic provider, a cache marker goes on the newest message's last block (string content becomes a block). */
function markLast(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const content: Block[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.map((block) => ({ ...block }));
  content[content.length - 1] = { ...content[content.length - 1]!, cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content }];
}

/** Anthropic Messages payload with cache markers on the system block, the last tool and the newest message. */
export function anthropic({ model = "claude-sonnet", tools = [tool("read"), tool("bash")], system = SYSTEM(), messages }: { model?: string; tools?: Tool[]; system?: string; messages: Message[] }) {
  return {
    model, max_tokens: 4096, stream: true, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: tools.map((item, index) => index === tools.length - 1 ? { ...item, cache_control: { type: "ephemeral" } } : item), messages: markLast(messages)
  };
}

export const BASE: Message[] = [user("fix the bug"), call("t1", "read"), result("t1", "x".repeat(5000)), call("t2", "bash"), result("t2", "ok"), reply("done")];

/** Provider-reported usage with Sonnet-like prices per token (input 3e-6, cache read 3e-7, cache write 3.75e-6). */
export const usage = (input: number, cacheRead: number, cacheWrite: number, priced = true) => ({
  input, cacheRead, cacheWrite,
  ...(priced ? { cost: { input: input * 3e-6, cacheRead: cacheRead * 3e-7, cacheWrite: cacheWrite * 3.75e-6, total: 0 } } : {})
});

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
