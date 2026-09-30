import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptChoice, promptText, todoView, type TodoFilter } from "./dialogs.ts";
import { TodoStore, todoProgress } from "./tasks.ts";

const help = "Usage: /jar tasks [list|add TITLE|done ID|open ID|edit ID TITLE|delete ID]";

export async function manageTasks(args: string, ctx: ExtensionContext, store: TodoStore, changed: () => void): Promise<void> {
  const notify = (text: string, severity: "info" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, severity);
    else console.log(text);
  };
  const list = () => {
    const items = store.all();
    notify(items.length ? items.map((item) => {
      const progress = todoProgress(items, item.id);
      return `${item.parentId ? "  " : ""}${item.done ? "[x]" : "[ ]"} ${item.title}${progress.total ? ` (${progress.done}/${progress.total})` : ""} (${item.id})`;
    }).join("\n") : "pi-jar to-do: empty (separate from other task managers)");
  };
  /** Deleting a parent also deletes its subtasks, so say so before confirming. */
  const deleteLabel = (id: string, title: string) => {
    const count = todoProgress(store.all(), id).total;
    return count ? `${title} (and ${count} subtask${count === 1 ? "" : "s"})` : title;
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
        const choice = item && await promptChoice(ctx, "Delete to-do?", deleteLabel(item.id, item.title), ["Delete item", "Keep item"], 1);
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
      // On a parent, done completes and open reopens every subtask.
      const item = id && store.get(id);
      const already = item && (verb === "done" ? item.done : item.status === "pending");
      if (item && !already && store.setStatus(id, verb === "done" ? "completed" : "pending")) { changed(); notify("Updated pi-jar to-do"); }
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
        const choice = await promptChoice(ctx, "Delete pi-jar to-do?", deleteLabel(id, store.get(id)!.title), ["Delete item", "Keep item"], 1);
        if (choice !== 0) return;
      }
      // Headless deletion is explicit and requires the full ID; TUI deletion asks for confirmation.
      if (store.delete(id)) { changed(); notify("Deleted pi-jar to-do"); }
      return;
    }
    default: notify(help, "error");
  }
}
