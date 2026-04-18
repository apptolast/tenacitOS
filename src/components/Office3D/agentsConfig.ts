/**
 * Office 3D — Agent layout (positions + colors).
 *
 * Visual layout only. Names, emojis, and live status are pulled at runtime
 * from /api/office (which reads openclaw.json + gateway sessions). Keep this
 * file in sync with the agents defined in the OpenClaw ConfigMap.
 *
 * Positions are in a roughly 12x12 office grid. Main agent sits at origin;
 * the other agents orbit around it.
 */

export interface AgentConfig {
  id: string;
  name: string;
  emoji: string;
  position: [number, number, number];
  color: string;
  role: string;
}

export const AGENTS: AgentConfig[] = [
  {
    id: "coordinador",
    name: "Coordinador",
    emoji: "🧠",
    position: [0, 0, 0],
    color: "#FFCC00",
    role: "Coordinator",
  },
  {
    id: "social-media",
    name: "Social",
    emoji: "📱",
    position: [-4, 0, -3],
    color: "#EC4899",
    role: "Social Media",
  },
  {
    id: "profe",
    name: "Profe",
    emoji: "📚",
    position: [4, 0, -3],
    color: "#4ADE80",
    role: "Teacher",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    emoji: "💼",
    position: [-4, 0, 3],
    color: "#0077B5",
    role: "LinkedIn Manager",
  },
  {
    id: "investigador",
    name: "Investigador",
    emoji: "🔬",
    position: [4, 0, 3],
    color: "#8B5CF6",
    role: "Researcher",
  },
  {
    id: "ideador",
    name: "Ideador",
    emoji: "💡",
    position: [0, 0, 6],
    color: "#F97316",
    role: "Brainstorming",
  },
  {
    id: "github-apptolast",
    name: "GitHub",
    emoji: "🐙",
    position: [-7, 0, 0],
    color: "#24292E",
    role: "GitHub Ops",
  },
  {
    id: "documentador",
    name: "Documentador",
    emoji: "📝",
    position: [7, 0, 0],
    color: "#06B6D4",
    role: "Documentation",
  },
];

export type AgentStatus = "idle" | "working" | "thinking" | "error";

export interface AgentState {
  id: string;
  status: AgentStatus;
  currentTask?: string;
  model?: string;
  tokensPerHour?: number;
  tasksInQueue?: number;
  uptime?: number;
}
