export type RoleState =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "reviewing"
  | "done"
  | "failed";

export interface RoleStatus {
  id: string;
  label: string;
  name: string;
  state: RoleState;
  task?: string;
}

/** Sample data only. Live teammates are supplied by external publishers, not by this list. */
export function createDemoRoles(): RoleStatus[] {
  return [
    { id: "explorer", label: "EXP", name: "Explorer", state: "thinking", task: "analyze" },
    { id: "builder", label: "BLD", name: "Builder", state: "working", task: "implement" },
    { id: "reviewer", label: "REV", name: "Reviewer", state: "waiting", task: "waiting" }
  ];
}
