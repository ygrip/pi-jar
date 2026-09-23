import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { WORKING_FRAMES, roleFrame } from "../src/animations.ts";
import { createDefaultRoles, createDemoRoles, type RoleStatus } from "../src/roles.ts";

let roles: RoleStatus[] = createDefaultRoles();
let animations = true;
let frame = 0;

const ACTIVE_STATES = new Set(["thinking", "working", "reviewing"]);

function roleColor(role: RoleStatus): "accent" | "warning" | "success" | "error" | "dim" {
  if (role.state === "failed") return "error";
  if (role.state === "done") return "success";
  if (role.state === "idle" || role.state === "waiting") return "dim";
  if (role.id === "petruk") return "warning";
  if (role.id === "bagong") return "success";
  return "accent";
}

function shouldAnimateRoles(): boolean {
  return animations && roles.some((role) => ACTIVE_STATES.has(role.state));
}

function installUi(ctx: ExtensionContext): void {
  ctx.ui.setTitle("pi-jar");

  ctx.ui.setWorkingIndicator({
    frames: [...WORKING_FRAMES],
    intervalMs: 140
  });

  ctx.ui.setFooter((tui, theme, footerData) => {
    const onBranchChange = footerData.onBranchChange(() => tui.requestRender());
    const timer = shouldAnimateRoles()
      ? setInterval(() => {
          frame += 1;
          tui.requestRender();
        }, 160)
      : undefined;

    return {
      dispose() {
        if (timer) clearInterval(timer);
        onBranchChange();
      },

      invalidate() {},

      render(width: number): string[] {
        const model = ctx.model?.id ?? "no-model";
        const branch = footerData.getGitBranch();
        const usage = ctx.getContextUsage();
        const context = usage?.percent == null ? "ctx ?" : `ctx ${Math.round(usage.percent)}%`;

        const left = theme.fg("accent", "pi-jar") + theme.fg("dim", `  ${model}`);
        const rightBits = [branch ? ` ${branch}` : undefined, context].filter(Boolean).join("  ");
        const right = theme.fg("dim", rightBits);
        const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

        const lines = [truncateToWidth(left + pad + right, width)];

        if (width >= 52) {
          const showTasks = width >= 100;
          const roleLine = roles
            .map((role) => {
              const glyph = roleFrame(role.state, frame, animations);
              const text = showTasks && role.task ? `${role.label} ${glyph} ${role.task}` : `${role.label} ${glyph}`;
              return theme.fg(roleColor(role), text);
            })
            .join(theme.fg("dim", "   "));

          lines.push(truncateToWidth(roleLine, width));
        }

        return lines;
      }
    };
  });
}

export default function piJar(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    installUi(ctx);
  });

  pi.registerCommand("jar", {
    description: "Configure pi-jar or preview its role-aware UI",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (!command || command === "status") {
        ctx.ui.notify(
          `pi-jar: animations ${animations ? "on" : "off"}; roles ${roles.map((role) => `${role.name}:${role.state}`).join(", ")}`,
          "info"
        );
        return;
      }

      if (command === "demo") {
        roles = createDemoRoles();
        installUi(ctx);
        ctx.ui.notify("pi-jar role demo enabled", "info");
        return;
      }

      if (command === "reset" || command === "demo off") {
        roles = createDefaultRoles();
        installUi(ctx);
        ctx.ui.notify("pi-jar role demo reset", "info");
        return;
      }

      if (command === "animations on") {
        animations = true;
        installUi(ctx);
        ctx.ui.notify("pi-jar animations enabled", "info");
        return;
      }

      if (command === "animations off") {
        animations = false;
        installUi(ctx);
        ctx.ui.notify("pi-jar animations disabled", "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /jar [status|demo|reset|animations on|animations off]",
        "error"
      );
    }
  });
}
