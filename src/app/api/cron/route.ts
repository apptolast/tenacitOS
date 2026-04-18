/**
 * Cron jobs API — proxies the local OpenClaw gateway HTTP API.
 *
 * The previous implementation shelled out to `openclaw cron list --json`,
 * but the CLI is not installed in the TenacitOS sidecar. The openclaw
 * container and the tenacitos sidecar share the pod network namespace, so
 * we can reach the gateway on http://localhost:18789 with the bearer token
 * from the Secret openclaw-credentials (env: OPENCLAW_GATEWAY_TOKEN).
 */
import { NextRequest, NextResponse } from "next/server";
import { gatewayFetch } from "@/lib/gateway";

interface GatewayCronJob {
  id: string;
  agentId?: string;
  name?: string;
  enabled?: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  schedule?: Record<string, unknown>;
  sessionTarget?: string;
  payload?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

function formatSchedule(schedule: Record<string, unknown> | undefined): string {
  if (!schedule) return "Unknown";
  switch (schedule.kind) {
    case "cron":
      return `${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    case "every": {
      const ms = (schedule.everyMs as number) || 0;
      if (ms >= 3600000) return `Every ${ms / 3600000}h`;
      if (ms >= 60000) return `Every ${ms / 60000}m`;
      return `Every ${ms / 1000}s`;
    }
    case "at":
      return `Once at ${schedule.at}`;
    default:
      return JSON.stringify(schedule);
  }
}

function formatDescription(job: GatewayCronJob): string {
  const payload = job.payload || {};
  if (payload.kind === "agentTurn") {
    const msg = (payload.message as string) || "";
    return msg.length > 120 ? msg.substring(0, 120) + "…" : msg;
  }
  if (payload.kind === "systemEvent") {
    const text = (payload.text as string) || "";
    return text.length > 120 ? text.substring(0, 120) + "…" : text;
  }
  return "";
}

export async function GET() {
  try {
    // The gateway exposes cron jobs at /api/v1/cron — we try a few likely
    // paths to remain forward-compatible with minor API renames.
    let payload: { jobs?: GatewayCronJob[] } | GatewayCronJob[] = [];
    const candidates = ["/api/cron", "/api/v1/cron", "/cron"];
    let lastErr: unknown = null;
    for (const p of candidates) {
      try {
        payload = await gatewayFetch(p, { timeoutMs: 6000 });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr && (!payload || (Array.isArray(payload) && payload.length === 0))) {
      throw lastErr;
    }

    const rawJobs: GatewayCronJob[] = Array.isArray(payload)
      ? payload
      : (payload.jobs || []);

    const jobs = rawJobs.map((job) => ({
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
        ? new Date(
            (job.state as Record<string, number>).nextRunAtMs
          ).toISOString()
        : null,
      lastRun: (job.state as Record<string, unknown> | undefined)?.lastRunAtMs
        ? new Date(
            (job.state as Record<string, number>).lastRunAtMs
          ).toISOString()
        : null,
    }));

    return NextResponse.json(jobs);
  } catch (error) {
    console.error("Error fetching cron jobs from gateway:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch cron jobs from OpenClaw gateway",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, enabled } = body;
    if (!id) {
      return NextResponse.json({ error: "Job ID is required" }, { status: 400 });
    }
    // Gateway's standard mutation endpoint; we try both shapes.
    const updates: Array<{ path: string; method: "POST" | "PATCH" | "PUT"; body: unknown }> = [
      { path: `/api/cron/${id}`, method: "PATCH", body: { enabled } },
      { path: `/api/cron/${id}/${enabled ? "enable" : "disable"}`, method: "POST", body: {} },
    ];
    let lastErr: unknown = null;
    for (const u of updates) {
      try {
        await gatewayFetch(u.path, { method: u.method, body: u.body, timeoutMs: 6000 });
        return NextResponse.json({ success: true, id, enabled });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  } catch (error) {
    console.error("Error updating cron job:", error);
    return NextResponse.json(
      {
        error: "Failed to update cron job",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Job ID is required" }, { status: 400 });
    }
    await gatewayFetch(`/api/cron/${id}`, { method: "DELETE", timeoutMs: 6000 });
    return NextResponse.json({ success: true, deleted: id });
  } catch (error) {
    console.error("Error deleting cron job:", error);
    return NextResponse.json(
      {
        error: "Failed to delete cron job",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  }
}
