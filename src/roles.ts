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

export function createDefaultRoles(): RoleStatus[] {
  return [
    { id: "gareng", label: "GAR", name: "Gareng", state: "idle" },
    { id: "petruk", label: "PET", name: "Petruk", state: "idle" },
    { id: "bagong", label: "BAG", name: "Bagong", state: "idle" }
  ];
}

export function createDemoRoles(): RoleStatus[] {
  return [
    { id: "gareng", label: "GAR", name: "Gareng", state: "thinking", task: "analyze" },
    { id: "petruk", label: "PET", name: "Petruk", state: "working", task: "implement" },
    { id: "bagong", label: "BAG", name: "Bagong", state: "waiting", task: "waiting" }
  ];
}
