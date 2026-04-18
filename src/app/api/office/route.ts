import { NextResponse } from "next/server";
import { readFileSync, statSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { OPENCLAW_CONFIG } from "@/lib/paths";
import { gatewayFetch } from "@/lib/gateway";

export const dynamic = "force-dynamic";

interface OpenClawAgent {
  id: string;
  name?: string;
  workspace?: string;
  identity?: { name?: string; emoji?: string; role?: string };
  ui?: { emoji?: string; color?: string };
}

interface OpenClawConfig {
  agents: {
    defaults?: { workspace?: string; model?: { primary?: string } };
    list: OpenClawAgent[];
  };
}

// Fallback emoji/color/role per known AppToLast agent.
// Extend this map if you add new agents. The visual layout in 3D (positions)
// is resolved in the frontend agentsConfig.ts.
const AGENT_VISUAL_DEFAULTS: Record<
  string,
  { emoji: string; color: string; role: string }
> = {
  coordinador: { emoji: "🧠", color: "#FFCC00", role: "Coordinator" },
  "social-media": { emoji: "📱", color: "#EC4899", role: "Social Media" },
  profe: { emoji: "📚", color: "#4ADE80", role: "Teacher" },
  linkedin: { emoji: "💼", color: "#0077B5", role: "LinkedIn Manager" },
  investigador: { emoji: "🔬", color: "#8B5CF6", role: "Researcher" },
  ideador: { emoji: "💡", color: "#F97316", role: "Brainstorming" },
  "github-apptolast": { emoji: "🐙", color: "#24292E", role: "GitHub Ops" },
  documentador: { emoji: "📝", color: "#06B6D4", role: "Documentation" },
  main: { emoji: "🦞", color: "#FF6B35", role: "Main Agent" },
};

interface GatewaySession {
  agentId?: string;
  key?: string;
  label?: string;
  updatedAt?: number;
  lastActivity?: string;
}

async function getAgentStatusFromGateway(): Promise<
  Record<string, { isActive: boolean; currentTask: string; lastSeen: number }>
> {
  try {
    const candidates = ["/api/sessions", "/api/v1/sessions"];
    let sessions: GatewaySession[] | null = null;
    for (const p of candidates) {
      try {
        const data = await gatewayFetch<unknown>(p, { timeoutMs: 2500 });
        if (Array.isArray(data)) {
          sessions = data as GatewaySession[];
          break;
        }
        const any = data as { sessions?: GatewaySession[]; items?: GatewaySession[] };
        if (any?.sessions) {
          sessions = any.sessions;
          break;
        }
        if (any?.items) {
          sessions = any.items;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!sessions) return {};

    const result: Record<string, { isActive: boolean; currentTask: string; lastSeen: number }> = {};
    const now = Date.now();

    for (const s of sessions) {
      const agentId = s.agentId || (s.key ? s.key.split(":")[1] : undefined);
      if (!agentId) continue;
      const ts =
        typeof s.updatedAt === "number"
          ? s.updatedAt
          : s.lastActivity
          ? new Date(s.lastActivity).getTime()
          : 0;
      if (!ts) continue;

      const minsAgo = (now - ts) / 60000;
      let label: string;
      let isActive: boolean;
      if (minsAgo < 5) {
        isActive = true;
        label = `ACTIVE: ${s.label || "Working on task…"}`;
      } else if (minsAgo < 30) {
        isActive = false;
        label = `IDLE: ${s.label || "Recent activity"}`;
      } else {
        isActive = false;
        label = "SLEEPING: zzZ…";
      }

      if (!result[agentId] || ts > result[agentId].lastSeen) {
        result[agentId] = { isActive, currentTask: label, lastSeen: ts };
      }
    }

    return result;
  } catch (err) {
    console.warn("office: gateway unreachable, falling back to memory files", err);
    return {};
  }
}

function getAgentStatusFromFiles(
  workspace: string
): { isActive: boolean; currentTask: string; lastSeen: number } {
  try {
    const memoryDir = join(workspace, "memory");
    if (!existsSync(memoryDir)) {
      return { isActive: false, currentTask: "SLEEPING: zzZ…", lastSeen: 0 };
    }
    const files = readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    if (files.length === 0) {
      return { isActive: false, currentTask: "SLEEPING: zzZ…", lastSeen: 0 };
    }
    files.sort().reverse();
    const latest = files[0];
    const st = statSync(join(memoryDir, latest));
    const lastSeen = st.mtime.getTime();
    const minsAgo = (Date.now() - lastSeen) / 60000;

    let currentTask = "Recent activity";
    try {
      const content = readFileSync(join(memoryDir, latest), "utf-8");
      const lastLine = content
        .split("\n")
        .filter((l) => l.trim().length > 20 && !l.startsWith("#"))
        .slice(-1)[0];
      if (lastLine) currentTask = lastLine.replace(/^[-*]\s*/, "").slice(0, 100);
    } catch {}

    if (minsAgo < 5) return { isActive: true, currentTask: `ACTIVE: ${currentTask}`, lastSeen };
    if (minsAgo < 60)
      return { isActive: false, currentTask: `IDLE: ${currentTask}`, lastSeen };
    return { isActive: false, currentTask: "SLEEPING: zzZ…", lastSeen };
  } catch {
    return { isActive: false, currentTask: "SLEEPING: zzZ…", lastSeen: 0 };
  }
}

export async function GET() {
  try {
    const config: OpenClawConfig = JSON.parse(
      readFileSync(OPENCLAW_CONFIG, "utf-8")
    );

    const gatewayStatus = await getAgentStatusFromGateway();

    const agents = (config.agents?.list || []).map((agent) => {
      const visual = AGENT_VISUAL_DEFAULTS[agent.id] || {
        emoji: agent.identity?.emoji || "🤖",
        color: agent.ui?.color || "#666666",
        role: "Agent",
      };
      const name = agent.name || agent.identity?.name || agent.id;
      const workspace = agent.workspace || `${config.agents.defaults?.workspace || ""}`;
      const gs = gatewayStatus[agent.id];
      const status = gs ?? getAgentStatusFromFiles(workspace);
      return {
        id: agent.id,
        name,
        emoji: agent.identity?.emoji || visual.emoji,
        color: agent.ui?.color || visual.color,
        role: visual.role,
        currentTask: status.currentTask,
        isActive: status.isActive,
        lastSeen: status.lastSeen,
      };
    });

    return NextResponse.json({ agents });
  } catch (error) {
    console.error("Error getting office data:", error);
    return NextResponse.json(
      {
        error: "Failed to load office data",
        detail: error instanceof Error ? error.message : String(error),
        agents: [],
      },
      { status: 500 }
    );
  }
}
