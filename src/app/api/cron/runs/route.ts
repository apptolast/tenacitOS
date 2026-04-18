/**
 * Cron run history — reads /home/node/.openclaw/cron/runs/<jobId>.jsonl
 *
 * Each JSONL line is a record with fields like:
 *   { ts, jobId, action: "started"|"finished", status, summary, durationMs,
 *     runAtMs, sessionId, model, provider, usage, deliveryStatus, ... }
 *
 * We group records per run (matched by sessionId or runAtMs) and surface
 * the most informative "finished" line plus the startedAt from the matching
 * "started" record.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { OPENCLAW_DIR } from "@/lib/paths";

interface RawRun {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  delivered?: boolean;
  deliveryStatus?: string;
  error?: string;
}

interface RunEntry {
  id: string;
  jobId: string;
  startedAt: string | null;
  completedAt: string | null;
  status: string;
  durationMs: number | null;
  summary: string | null;
  model: string | null;
  provider: string | null;
  deliveryStatus: string | null;
  error: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Job ID required" }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    const file = join(OPENCLAW_DIR, "cron", "runs", `${id}.jsonl`);
    if (!existsSync(file)) {
      return NextResponse.json({ runs: [], total: 0 });
    }

    const raw = readFileSync(file, "utf-8");
    const records: RawRun[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as RawRun);
      } catch {
        // skip malformed
      }
    }

    // Group by (sessionId ?? runAtMs). Keep most informative record per group.
    const byKey = new Map<string, { started?: RawRun; finished?: RawRun }>();
    for (const r of records) {
      const k = r.sessionId || (r.runAtMs ? String(r.runAtMs) : String(r.ts));
      const slot = byKey.get(k) || {};
      if (r.action === "started") slot.started = r;
      else slot.finished = r;
      byKey.set(k, slot);
    }

    const runs: RunEntry[] = [];
    for (const [k, { started, finished }] of byKey.entries()) {
      const src = finished || started;
      if (!src) continue;
      const startedAtMs = started?.runAtMs || (src as RawRun).runAtMs || started?.ts || src.ts;
      const completedAtMs = finished?.ts;
      runs.push({
        id: `${id}-${k}`,
        jobId: id,
        startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
        completedAt: completedAtMs ? new Date(completedAtMs).toISOString() : null,
        status: src.status || (src.action === "finished" ? "ok" : "running"),
        durationMs: src.durationMs ?? null,
        summary: src.summary ?? null,
        model: src.model ?? null,
        provider: src.provider ?? null,
        deliveryStatus: src.deliveryStatus ?? null,
        error: src.error ?? null,
      });
    }

    runs.sort(
      (a, b) =>
        (b.startedAt ? Date.parse(b.startedAt) : 0) -
        (a.startedAt ? Date.parse(a.startedAt) : 0)
    );

    return NextResponse.json({ runs, total: runs.length });
  } catch (error) {
    console.error("Error fetching cron runs:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch run history",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
