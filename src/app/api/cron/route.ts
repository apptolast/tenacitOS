/**
 * Cron jobs API — reads jobs.json from the OpenClaw PVC.
 *
 * The OpenClaw gateway does not expose a JSON REST API for cron; its HTTP
 * endpoints serve the Control UI HTML. The canonical source of truth for
 * cron jobs is /home/node/.openclaw/cron/jobs.json, which the gateway
 * writes on every update. Mutations (PUT/DELETE) are currently unsupported
 * from the sidecar: we would need to talk to the WebSocket control plane
 * or edit the JSON file directly (and risk racing the gateway). The UI
 * degrades gracefully to read-only for now.
 */
import { NextResponse } from "next/server";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { OPENCLAW_DIR } from "@/lib/paths";

const JOBS_FILE = join(OPENCLAW_DIR, "cron", "jobs.json");

interface RawJob {
  id?: string;
  name?: string;
  agentId?: string;
  enabled?: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  schedule?: Record<string, unknown>;
  sessionTarget?: string;
  payload?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  state?: Record<string, unknown>;
  deleteAfterRun?: boolean;
  timeoutSeconds?: number;
  wakeMode?: string;
}

interface JobsFile {
  version?: number;
  jobs?: RawJob[];
}

function formatSchedule(schedule: Record<string, unknown> | undefined): string {
  if (!schedule) return "Unknown";
  switch (schedule.kind) {
    case "cron":
      return `${schedule.expr || ""}${schedule.tz ? ` (${schedule.tz})` : ""}`.trim();
    case "every": {
      const ms = (schedule.everyMs as number) || 0;
      if (ms >= 3600000) return `Every ${ms / 3600000}h`;
      if (ms >= 60000) return `Every ${ms / 60000}m`;
      return `Every ${ms / 1000}s`;
    }
    case "at":
      return `Once at ${schedule.at || "?"}`;
    default:
      return JSON.stringify(schedule);
  }
}

function formatDescription(job: RawJob): string {
  const payload = job.payload || {};
  if (payload.kind === "agentTurn") {
    const msg = (payload.message as string) || "";
    return msg.length > 140 ? msg.substring(0, 140) + "…" : msg;
  }
  if (payload.kind === "systemEvent") {
    const text = (payload.text as string) || "";
    return text.length > 140 ? text.substring(0, 140) + "…" : text;
  }
  return "";
}

function loadJobs(): { jobs: RawJob[]; fileMtimeMs: number | null } {
  if (!existsSync(JOBS_FILE)) return { jobs: [], fileMtimeMs: null };
  try {
    const raw = readFileSync(JOBS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as JobsFile | RawJob[];
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs || [];
    const mtime = statSync(JOBS_FILE).mtimeMs;
    return { jobs, fileMtimeMs: mtime };
  } catch (err) {
    console.error("[cron] Failed to parse jobs.json:", err);
    return { jobs: [], fileMtimeMs: null };
  }
}

export async function GET() {
  try {
    const { jobs: raw, fileMtimeMs } = loadJobs();
    const jobs = raw.map((job) => ({
      id: job.id,
      agentId: job.agentId || "main",
      name: job.name || "Unnamed",
      enabled: job.enabled ?? true,
      createdAtMs: job.createdAtMs,
      updatedAtMs: job.updatedAtMs,
      schedule: job.schedule,
      sessionTarget: job.sessionTarget,
      payload: job.payload,
      delivery: job.delivery,
      state: job.state,
      description: formatDescription(job),
      scheduleDisplay: formatSchedule(job.schedule),
      timezone:
        (job.schedule as Record<string, string> | undefined)?.tz || "UTC",
      nextRun: (job.state as Record<string, unknown> | undefined)?.nextRunAtMs
        ? new Date((job.state as Record<string, number>).nextRunAtMs).toISOString()
        : null,
      lastRun: (job.state as Record<string, unknown> | undefined)?.lastRunAtMs
        ? new Date((job.state as Record<string, number>).lastRunAtMs).toISOString()
        : null,
    }));

    return NextResponse.json(jobs, {
      headers: fileMtimeMs
        ? { "X-Cron-Source-Mtime": new Date(fileMtimeMs).toISOString() }
        : {},
    });
  } catch (error) {
    console.error("Error loading cron jobs:", error);
    return NextResponse.json(
      {
        error: "Failed to load cron jobs",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export async function PUT() {
  return NextResponse.json(
    {
      error:
        "Cron mutations are not supported from the sidecar. Edit cron/jobs.json via `openclaw cron enable/disable` in the openclaw container.",
    },
    { status: 501 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    {
      error:
        "Cron mutations are not supported from the sidecar. Remove the job via `openclaw cron remove <id>` in the openclaw container.",
    },
    { status: 501 }
  );
}
