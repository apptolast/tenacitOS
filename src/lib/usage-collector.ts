/**
 * Usage Collector - Reads OpenClaw session data and calculates costs
 */

import { calculateCost, normalizeModelId } from "./pricing";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { gatewayFetch } from "./gateway";

export interface SessionData {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  updatedAt: number;
  percentUsed: number;
}

export interface UsageSnapshot {
  timestamp: number;
  date: string; // YYYY-MM-DD
  hour: number; // 0-23
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

/**
 * Get current OpenClaw status (sessions) from the local gateway.
 * Previously this shelled out to `openclaw status --json`, but the CLI is
 * not installed in the TenacitOS sidecar. We now hit the gateway HTTP API
 * on localhost:18789 (shared pod network namespace).
 */
export async function getOpenClawStatus(): Promise<{ sessions?: { byAgent?: Array<{ agentId: string; recent?: Array<Record<string, unknown>> }> } }> {
  const candidates = ["/api/status", "/api/v1/status", "/api/sessions", "/api/v1/sessions"];
  let lastErr: unknown = null;
  for (const p of candidates) {
    try {
      const data = await gatewayFetch<unknown>(p, { timeoutMs: 5000 });
      const d = data as { sessions?: unknown; items?: unknown; byAgent?: unknown } | Array<unknown>;
      if (Array.isArray(d)) {
        return { sessions: { byAgent: [{ agentId: "main", recent: d as Array<Record<string, unknown>> }] } };
      }
      const any = d as { sessions?: { byAgent?: unknown } | unknown[]; items?: unknown[]; byAgent?: unknown[] };
      if (any?.sessions) return { sessions: any.sessions as { byAgent?: Array<{ agentId: string; recent?: Array<Record<string, unknown>> }> } };
      if (Array.isArray(any?.items)) {
        return { sessions: { byAgent: [{ agentId: "main", recent: any.items as Array<Record<string, unknown>> }] } };
      }
      if (Array.isArray(any?.byAgent)) {
        return { sessions: { byAgent: any.byAgent as Array<{ agentId: string; recent?: Array<Record<string, unknown>> }> } };
      }
      return d as { sessions?: { byAgent?: Array<{ agentId: string; recent?: Array<Record<string, unknown>> }> } };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("gateway unreachable");
}

/**
 * Extract session data from status
 */
export function extractSessionData(status: any): SessionData[] {
  const sessions: SessionData[] = [];

  if (!status.sessions?.byAgent) {
    return sessions;
  }

  for (const agentGroup of status.sessions.byAgent) {
    const agentId = agentGroup.agentId;

    for (const session of agentGroup.recent || []) {
      sessions.push({
        agentId,
        sessionKey: session.key,
        sessionId: session.sessionId,
        model: normalizeModelId(session.model || "unknown"),
        inputTokens: session.inputTokens || 0,
        outputTokens: session.outputTokens || 0,
        totalTokens: session.totalTokens || 0,
        updatedAt: session.updatedAt,
        percentUsed: session.percentUsed || 0,
      });
    }
  }

  return sessions;
}

/**
 * Calculate cost snapshot from session data
 */
export function calculateSnapshot(
  sessions: SessionData[],
  timestamp: number
): UsageSnapshot[] {
  const snapshots: UsageSnapshot[] = [];
  const date = new Date(timestamp);
  const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
  const hour = date.getUTCHours();

  // Group by agent and model
  const grouped = new Map<string, SessionData[]>();

  for (const session of sessions) {
    const key = `${session.agentId}:${session.model}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(session);
  }

  // Calculate totals and costs
  for (const [key, group] of grouped.entries()) {
    const [agentId, model] = key.split(":");
    const inputTokens = group.reduce((sum, s) => sum + s.inputTokens, 0);
    const outputTokens = group.reduce((sum, s) => sum + s.outputTokens, 0);
    const totalTokens = group.reduce((sum, s) => sum + s.totalTokens, 0);
    const cost = calculateCost(model, inputTokens, outputTokens);

    snapshots.push({
      timestamp,
      date: dateStr,
      hour,
      agentId,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
    });
  }

  return snapshots;
}

/**
 * Initialize SQLite database for usage tracking
 */
export function initDatabase(dbPath: string): Database.Database {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Create table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_date ON usage_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_agent ON usage_snapshots(agent_id);
    CREATE INDEX IF NOT EXISTS idx_model ON usage_snapshots(model);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_snapshots(timestamp);
  `);

  return db;
}

/**
 * Save snapshot to database
 */
export function saveSnapshot(
  db: Database.Database,
  snapshot: UsageSnapshot
): void {
  const stmt = db.prepare(`
    INSERT INTO usage_snapshots 
      (timestamp, date, hour, agent_id, model, input_tokens, output_tokens, total_tokens, cost)
    VALUES 
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    snapshot.timestamp,
    snapshot.date,
    snapshot.hour,
    snapshot.agentId,
    snapshot.model,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.totalTokens,
    snapshot.cost
  );
}

/**
 * Collect and save current usage data
 * This captures a point-in-time snapshot of current session totals
 */
export async function collectUsage(dbPath: string): Promise<void> {
  const db = initDatabase(dbPath);

  try {
    // Get current status
    const status = await getOpenClawStatus();
    const sessions = extractSessionData(status);
    const timestamp = Date.now();
    const snapshots = calculateSnapshot(sessions, timestamp);

    // Delete any snapshots from the same hour (avoid duplicates)
    const hour = new Date(timestamp).getUTCHours();
    const date = new Date(timestamp).toISOString().split("T")[0];
    
    db.prepare(`
      DELETE FROM usage_snapshots 
      WHERE date = ? AND hour = ?
    `).run(date, hour);

    // Save new snapshots
    for (const snapshot of snapshots) {
      saveSnapshot(db, snapshot);
    }

    console.log(`Collected ${snapshots.length} usage snapshots for ${date} ${hour}:00 UTC`);
  } finally {
    db.close();
  }
}
