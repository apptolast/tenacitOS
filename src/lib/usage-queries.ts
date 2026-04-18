/**
 * Usage Queries - Read usage data from SQLite
 */

import Database from "better-sqlite3";
import fs from "fs";
import { dataFile } from "./paths";

const DEFAULT_DB_PATH = dataFile("usage-tracking.db");

export interface CostSummary {
  today: number;
  yesterday: number;
  thisMonth: number;
  lastMonth: number;
  projected: number;
}

export interface AgentCost {
  agent: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  percentOfTotal: number;
}

export interface ModelCost {
  model: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  percentOfTotal: number;
}

export interface DailyCost {
  date: string; // MM-DD
  cost: number;
  input: number;
  output: number;
}

export interface HourlyCost {
  hour: string; // HH:00
  cost: number;
}

export function getDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database | null {
  if (!fs.existsSync(dbPath)) {
    console.warn(`Database not found: ${dbPath}`);
    return null;
  }
  return new Database(dbPath, { readonly: true });
}

/**
 * Get cost summary (today, yesterday, this month, last month)
 */
export function getCostSummary(db: Database.Database): CostSummary {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthStartStr = lastMonthStart.toISOString().split("T")[0];
  const lastMonthEndStr = lastMonthEnd.toISOString().split("T")[0];

  // Today's cost
  const todayResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date = ?
  `).get(today) as { total: number };

  // Yesterday's cost
  const yesterdayResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date = ?
  `).get(yesterdayStr) as { total: number };

  // This month's cost
  const thisMonthResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date >= ?
  `).get(thisMonthStart) as { total: number };

  // Last month's cost
  const lastMonthResult = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_snapshots WHERE date >= ? AND date <= ?
  `).get(lastMonthStartStr, lastMonthEndStr) as { total: number };

  // Calculate projection (based on average daily spend this month)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = now.getDate();
  const avgDailySpend = daysElapsed > 0 ? thisMonthResult.total / daysElapsed : 0;
  const projected = avgDailySpend * daysInMonth;

  return {
    today: todayResult.total,
    yesterday: yesterdayResult.total,
    thisMonth: thisMonthResult.total,
    lastMonth: lastMonthResult.total,
    projected,
  };
}

/**
 * Get cost breakdown by agent
 */
export function getCostByAgent(db: Database.Database, days: number = 30): AgentCost[] {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const results = db.prepare(`
    SELECT 
      agent_id as agent,
      SUM(cost) as cost,
      SUM(total_tokens) as tokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens
    FROM usage_snapshots
    WHERE date >= ?
    GROUP BY agent_id
    ORDER BY cost DESC
  `).all(cutoffStr) as AgentCost[];

  const total = results.reduce((sum, r) => sum + r.cost, 0);

  return results.map((r) => ({
    ...r,
    percentOfTotal: total > 0 ? (r.cost / total) * 100 : 0,
  }));
}

/**
 * Get cost breakdown by model
 */
export function getCostByModel(db: Database.Database, days: number = 30): ModelCost[] {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const results = db.prepare(`
    SELECT 
      model,
      SUM(cost) as cost,
      SUM(total_tokens) as tokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens
    FROM usage_snapshots
    WHERE date >= ?
    GROUP BY model
    ORDER BY cost DESC
  `).all(cutoffStr) as ModelCost[];

  const total = results.reduce((sum, r) => sum + r.cost, 0);

  return results.map((r) => ({
    ...r,
    percentOfTotal: total > 0 ? (r.cost / total) * 100 : 0,
  }));
}

/**
 * Get daily cost trend
 */
export function getDailyCost(db: Database.Database, days: number = 30): DailyCost[] {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const results = db.prepare(`
    SELECT 
      date,
      SUM(cost) as cost,
      SUM(input_tokens) as input,
      SUM(output_tokens) as output
    FROM usage_snapshots
    WHERE date >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(cutoffStr) as Array<{
    date: string;
    cost: number;
    input: number;
    output: number;
  }>;

  // Format date as MM-DD
  return results.map((r) => ({
    date: r.date.slice(5), // YYYY-MM-DD → MM-DD
    cost: parseFloat(r.cost.toFixed(2)),
    input: r.input,
    output: r.output,
  }));
}

/**
 * Get hourly cost trend (last 24h)
 */
export function getHourlyCost(db: Database.Database): HourlyCost[] {
  const cutoffTimestamp = Date.now() - 24 * 60 * 60 * 1000; // 24h ago

  const results = db.prepare(`
    SELECT 
      hour,
      SUM(cost) as cost
    FROM usage_snapshots
    WHERE timestamp >= ?
    GROUP BY hour
    ORDER BY hour ASC
  `).all(cutoffTimestamp) as Array<{
    hour: number;
    cost: number;
  }>;

  return results.map((r) => ({
    hour: `${String(r.hour).padStart(2, "0")}:00`,
    cost: parseFloat(r.cost.toFixed(2)),
  }));
}
