/**
 * Costs & Analytics API
 *
 * Anterior: abria `usage-tracking.db` (SQLite poblada por un script
 * collect-usage que nadie ejecutaba) y devolvia $0 para todo.
 *
 * Ahora: deriva los costes directamente del PVC, escaneando:
 *  - `cron/runs/<jobId>.jsonl`: cada record `action="finished"` trae
 *    `ts`, `model`, `provider`, `sessionKey` y `usage.{input_tokens,
 *    output_tokens}`.
 *  - `agents/<agentId>/sessions/<uuid>.jsonl`: los records `message`
 *    llevan `timestamp` + `message.usage.{input_tokens, output_tokens,
 *    cache_read_input_tokens, cache_creation_input_tokens}`. El modelo
 *    activo se trackea por `model_change` records en la misma sesion.
 *
 * Los costes usan `calculateCost(modelId, inputTokens, outputTokens)` con
 * el catalogo de `lib/pricing.ts`. Para GitHub Copilot (Pro+ flat-rate) el
 * coste mostrado es el equivalente al modelo Anthropic subyacente — "valor
 * entregado" en lugar de "dolares pagados a OpenAI/Anthropic".
 */
import { NextRequest, NextResponse } from "next/server";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { OPENCLAW_DIR } from "@/lib/paths";
import { calculateCost, normalizeModelId } from "@/lib/pricing";

const DEFAULT_BUDGET = 100.0;

interface UsageRecord {
  ts: number;
  agentId: string;
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
}

interface RunJsonl {
  ts?: number;
  action?: string;
  model?: string;
  provider?: string;
  sessionKey?: string;
  agentId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input?: number;
    output?: number;
  };
}

interface JsonlLine {
  type?: string;
  timestamp?: string;
  modelId?: string;
  provider?: string;
  customType?: string;
  data?: { modelId?: string; provider?: string };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function agentIdFromSessionKey(key?: string): string | undefined {
  if (!key) return undefined;
  const parts = key.split(":");
  // agent:<agentId>:... — "agent" literal at parts[0], id at parts[1]
  return parts[0] === "agent" ? parts[1] : undefined;
}

function extractUsage(u: RunJsonl["usage"]): { input: number; output: number } {
  if (!u) return { input: 0, output: 0 };
  const input =
    (u.input_tokens ?? u.input ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const output = u.output_tokens ?? u.output ?? 0;
  return { input, output };
}

function scanCronRuns(): UsageRecord[] {
  const runsDir = join(OPENCLAW_DIR, "cron", "runs");
  if (!existsSync(runsDir)) return [];
  const out: UsageRecord[] = [];
  for (const f of readdirSync(runsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    let raw = "";
    try {
      raw = readFileSync(join(runsDir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t) as RunJsonl;
        if (r.action !== "finished" || !r.ts) continue;
        const { input, output } = extractUsage(r.usage);
        if (input === 0 && output === 0) continue;
        const agentId = r.agentId || agentIdFromSessionKey(r.sessionKey) || "unknown";
        out.push({
          ts: r.ts,
          agentId,
          model: normalizeModelId(r.model || "unknown"),
          provider: r.provider,
          inputTokens: input,
          outputTokens: output,
        });
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

function scanSessionFile(agentId: string, filePath: string): UsageRecord[] {
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  let currentModel = "unknown";
  let currentProvider: string | undefined;

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as JsonlLine;
      if (obj.type === "model_change") {
        if (obj.modelId) currentModel = obj.modelId;
        if (obj.provider) currentProvider = obj.provider;
        continue;
      }
      if (obj.type === "custom" && obj.customType === "model-snapshot") {
        if (obj.data?.modelId) currentModel = obj.data.modelId;
        if (obj.data?.provider) currentProvider = obj.data.provider;
        continue;
      }
      if (obj.type !== "message" || !obj.message) continue;
      const { input, output } = extractUsage(obj.message.usage);
      if (input === 0 && output === 0) continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
      if (!ts) continue;
      out.push({
        ts,
        agentId,
        model: normalizeModelId(currentModel),
        provider: currentProvider,
        inputTokens: input,
        outputTokens: output,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function scanSessions(): UsageRecord[] {
  const agentsDir = join(OPENCLAW_DIR, "agents");
  if (!existsSync(agentsDir)) return [];
  const out: UsageRecord[] = [];
  for (const agentId of readdirSync(agentsDir)) {
    const sessionsDir = join(agentsDir, agentId, "sessions");
    if (!existsSync(sessionsDir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      out.push(...scanSessionFile(agentId, join(sessionsDir, f)));
    }
  }
  return out;
}

function dayStrUTC(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildAnalytics(records: UsageRecord[], days: number) {
  const now = new Date();
  const today = dayStrUTC(now.getTime());
  const yesterday = dayStrUTC(now.getTime() - 86400_000);
  const thisMonthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const lastMonthD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonthStart = dayStrUTC(lastMonthD.getTime());
  const lastMonthEnd = dayStrUTC(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)
  );

  const daysInMonth = new Date(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    0
  ).getUTCDate();
  const daysElapsed = now.getUTCDate();

  const cutoffMs = now.getTime() - days * 86400_000;
  const cutoff24hMs = now.getTime() - 86400_000;

  let todayCost = 0;
  let yesterdayCost = 0;
  let thisMonthCost = 0;
  let lastMonthCost = 0;

  const byAgent = new Map<
    string,
    { cost: number; tokens: number; inputTokens: number; outputTokens: number }
  >();
  const byModel = new Map<
    string,
    { cost: number; tokens: number; inputTokens: number; outputTokens: number }
  >();
  const daily = new Map<
    string,
    { cost: number; input: number; output: number }
  >();
  const hourly = new Map<string, number>();

  for (const r of records) {
    const cost = calculateCost(r.model, r.inputTokens, r.outputTokens);
    const day = dayStrUTC(r.ts);
    const total = r.inputTokens + r.outputTokens;

    if (day === today) todayCost += cost;
    if (day === yesterday) yesterdayCost += cost;
    if (day >= thisMonthStart) thisMonthCost += cost;
    if (day >= lastMonthStart && day <= lastMonthEnd) lastMonthCost += cost;

    if (r.ts >= cutoffMs) {
      const a = byAgent.get(r.agentId) || {
        cost: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      a.cost += cost;
      a.tokens += total;
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      byAgent.set(r.agentId, a);

      const m = byModel.get(r.model) || {
        cost: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      m.cost += cost;
      m.tokens += total;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      byModel.set(r.model, m);

      const d = daily.get(day) || { cost: 0, input: 0, output: 0 };
      d.cost += cost;
      d.input += r.inputTokens;
      d.output += r.outputTokens;
      daily.set(day, d);
    }

    if (r.ts >= cutoff24hMs) {
      const hour = String(new Date(r.ts).getUTCHours()).padStart(2, "0");
      hourly.set(hour, (hourly.get(hour) || 0) + cost);
    }
  }

  const avgDailySpend = daysElapsed > 0 ? thisMonthCost / daysElapsed : 0;
  const projected = avgDailySpend * daysInMonth;

  const totalByAgent = Array.from(byAgent.values()).reduce(
    (s, x) => s + x.cost,
    0
  );
  const totalByModel = Array.from(byModel.values()).reduce(
    (s, x) => s + x.cost,
    0
  );

  return {
    today: round(todayCost),
    yesterday: round(yesterdayCost),
    thisMonth: round(thisMonthCost),
    lastMonth: round(lastMonthCost),
    projected: round(projected),
    byAgent: Array.from(byAgent.entries())
      .map(([agent, v]) => ({
        agent,
        cost: round(v.cost),
        tokens: v.tokens,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        percentOfTotal: totalByAgent > 0 ? round((v.cost / totalByAgent) * 100) : 0,
      }))
      .sort((a, b) => b.cost - a.cost),
    byModel: Array.from(byModel.entries())
      .map(([model, v]) => ({
        model,
        cost: round(v.cost),
        tokens: v.tokens,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        percentOfTotal: totalByModel > 0 ? round((v.cost / totalByModel) * 100) : 0,
      }))
      .sort((a, b) => b.cost - a.cost),
    daily: Array.from(daily.entries())
      .map(([date, v]) => ({
        date: date.slice(5), // MM-DD
        cost: round(v.cost),
        input: v.input,
        output: v.output,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    hourly: Array.from(hourly.entries())
      .map(([hour, cost]) => ({ hour: `${hour}:00`, cost: round(cost) }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const timeframe = searchParams.get("timeframe") || "30d";
  const days = parseInt(timeframe.replace(/\D/g, ""), 10) || 30;

  try {
    const records = [...scanCronRuns(), ...scanSessions()];
    const analytics = buildAnalytics(records, days);

    return NextResponse.json({
      ...analytics,
      budget: DEFAULT_BUDGET,
      sources: {
        totalRecords: records.length,
        note: "Costs derived from cron/runs + session JSONL files on the PVC. GitHub Copilot pricing shown as equivalent Anthropic price (Pro+ is flat-rate).",
      },
    });
  } catch (error) {
    console.error("Error computing cost analytics:", error);
    return NextResponse.json(
      {
        error: "Failed to compute cost analytics",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { budget, alerts } = body;
    // TODO: persist budget to PVC once the UI provides the edit flow.
    return NextResponse.json({ success: true, budget, alerts });
  } catch (error) {
    console.error("Error updating budget:", error);
    return NextResponse.json(
      { error: "Failed to update budget" },
      { status: 500 }
    );
  }
}
