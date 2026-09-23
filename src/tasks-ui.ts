import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptChoice, promptText, todoView, type TodoFilter } from "./dialogs.ts";
import { TodoStore } from "./tasks.ts";

const help = "Usage: /jar tasks [list|add TITLE|done ID|open ID|edit ID TITLE|delete ID]";

export async function manageTasks(args: string, ctx: ExtensionContext, store: TodoStore, changed: () => void): Promise<void> {
  const notify = (text: string, severity: "info" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, severity);
    else console.log(text);
  };
  const list = () => {
    const items = store.all();
    notify(items.length ? items.map((item) => `${item.done ? "[x]" : "[ ]"} ${item.title} (${item.id})`).join("\n") : "pi-jar to-do: empty (separate from Team Mode)");
  };
  if (!args && ctx.hasUI && ctx.mode === "tui") {
    const filter: { value: TodoFilter } = { value: "all" };
    while (true) {
      const action = await todoView(ctx, () => store.all(), filter);
      if (!action) break;
      let success = false;
      if (action.kind === "add") {
        const title = await promptText(ctx, "Add pi-jar to-do", "What needs doing?");
        if (title) success = !!store.add(title);
      } else if (action.id && action.kind === "toggle") success = store.toggle(action.id);
      else if (action.id && action.kind === "edit") {
        const previous = store.get(action.id);
        const title = previous && await promptText(ctx, "Edit pi-jar to-do", "Update the title", previous.title);
        if (title) success = store.edit(action.id, title);
      } else if (action.id && action.kind === "delete") {
        const item = store.get(action.id);
        const choice = item && await promptChoice(ctx, "Delete to-do?", item.title, ["Delete item", "Keep item"], 1);
        if (choice === 0) success = store.delete(action.id);
      }
      if (success) changed();
    }
    return;
  }
  const [verb = "list", id, ...titleParts] = args.split(/\s+/);
  switch (verb.toLowerCase()) {
    case "list": list(); return;
    case "add": {
      const title = args.slice(4).trim();
      if (store.add(title)) { changed(); notify("Added pi-jar to-do"); }
      else notify(help, "error");
      return;
    }
    case "done":
    case "open": {
      const item = id && store.get(id);
      if (item && item.done !== (verb === "done") && store.toggle(id)) { changed(); notify("Updated pi-jar to-do"); }
      else notify("To-do not found or already in that state", "error");
      return;
    }
    case "edit": {
      const title = titleParts.join(" ");
      if (id && store.edit(id, title)) { changed(); notify("Edited pi-jar to-do"); }
      else notify(help, "error");
      return;
    }
    case "delete": {
      if (!id || !store.get(id)) { notify("To-do not found", "error"); return; }
      if (ctx.hasUI && ctx.mode === "tui") {
        const choice = await promptChoice(ctx, "Delete pi-jar to-do?", store.get(id)!.title, ["Delete item", "Keep item"], 1);
        if (choice !== 0) return;
      }
      // Headless deletion is explicit and requires the full ID; TUI deletion asks for confirmation.
      if (store.delete(id)) { changed(); notify("Deleted pi-jar to-do"); }
      return;
    }
    default: notify(help, "error");
  }
}
