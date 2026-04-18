/**
 * Activity Stats API
 * GET /api/activities/stats
 * Returns heatmap, counts by type/status, recent trend and hourly distribution.
 *
 * If the local SQLite activities.db is empty (fresh PVC state after the first
 * rollout where tenacitos writes started), we fall back to deriving stats from
 * the OpenClaw PVC — specifically cron/runs/*.jsonl and agents/<id>/sessions/*.jsonl
 * — so the Dashboard and Analytics pages do not show "0" for a system that has
 * actually been running for months.
 */
import { NextResponse } from 'next/server';
import { getActivityStats } from '@/lib/activities-db';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { dataFile, OPENCLAW_DIR } from '@/lib/paths';

interface DerivedEntry {
  ts: number;            // epoch ms
  type: string;          // 'cron' | 'message'
  status: 'success' | 'error' | 'pending';
}

function deriveFromPvc(): DerivedEntry[] {
  const out: DerivedEntry[] = [];

  const cronRunsDir = path.join(OPENCLAW_DIR, 'cron', 'runs');
  if (fs.existsSync(cronRunsDir)) {
    try {
      for (const f of fs.readdirSync(cronRunsDir)) {
        if (!f.endsWith('.jsonl')) continue;
        let raw = '';
        try { raw = fs.readFileSync(path.join(cronRunsDir, f), 'utf-8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            const rec = JSON.parse(t) as { action?: string; ts?: number; status?: string };
            if (rec.action !== 'finished' || !rec.ts) continue;
            const status: DerivedEntry['status'] =
              rec.status === 'error' ? 'error' : 'success';
            out.push({ ts: rec.ts, type: 'cron', status });
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch { /* ignore */ }
  }

  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  if (fs.existsSync(agentsDir)) {
    try {
      for (const agentId of fs.readdirSync(agentsDir)) {
        const sessionsDir = path.join(agentsDir, agentId, 'sessions');
        if (!fs.existsSync(sessionsDir)) continue;
        try {
          for (const f of fs.readdirSync(sessionsDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const st = fs.statSync(path.join(sessionsDir, f));
            out.push({ ts: st.mtimeMs, type: 'message', status: 'success' });
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  return out;
}

function buildDerivedStats(entries: DerivedEntry[]) {
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const cutoff365 = now - 365 * 24 * 3600 * 1000;
  const cutoff30  = now - 30  * 24 * 3600 * 1000;
  const cutoff7   = now - 7   * 24 * 3600 * 1000;

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let today = 0;

  const heatmapMap = new Map<string, number>();
  const trendMap = new Map<string, { count: number; success: number; errors: number }>();
  const hourlyMap = new Map<string, number>();

  for (const e of entries) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;

    if (e.ts >= todayStart.getTime()) today++;

    if (e.ts >= cutoff365) {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      heatmapMap.set(day, (heatmapMap.get(day) || 0) + 1);
    }

    if (e.ts >= cutoff7) {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      const cur = trendMap.get(day) || { count: 0, success: 0, errors: 0 };
      cur.count++;
      if (e.status === 'success') cur.success++;
      else if (e.status === 'error') cur.errors++;
      trendMap.set(day, cur);
    }

    if (e.ts >= cutoff30) {
      const hour = String(new Date(e.ts).getHours()).padStart(2, '0');
      hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + 1);
    }
  }

  const heatmap = Array.from(heatmapMap.entries())
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const trend = Array.from(trendMap.entries())
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => b.day.localeCompare(a.day));

  const hourly = Array.from(hourlyMap.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 24);

  return {
    total: entries.length,
    today,
    byType,
    byStatus,
    heatmap,
    trend,
    hourly,
  };
}

export async function GET() {
  try {
    const stats = getActivityStats();
    const DB_PATH = dataFile('activities.db');

    // If SQLite is empty OR missing, derive from PVC. The Dashboard relies on
    // this endpoint for the "Total Activities / Today / Successful / Errors"
    // cards, so returning zeros hides all real system activity.
    let derived = false;
    let heatmap: Array<{ day: string; count: number }> = [];
    let trend: Array<{ day: string; count: number; success: number; errors: number }> = [];
    let hourly: Array<{ hour: string; count: number }> = [];
    let out = stats;

    if (stats.total === 0 || !fs.existsSync(DB_PATH)) {
      const entries = deriveFromPvc();
      if (entries.length > 0) {
        derived = true;
        const built = buildDerivedStats(entries);
        out = {
          total: built.total,
          today: built.today,
          byType: built.byType,
          byStatus: built.byStatus,
        };
        heatmap = built.heatmap;
        trend = built.trend;
        hourly = built.hourly;
      }
    }

    // If SQLite has data and we haven't derived, read the actual series from it.
    if (!derived && fs.existsSync(DB_PATH)) {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
        heatmap = db.prepare(`
          SELECT DATE(timestamp) as day, COUNT(*) as count
          FROM activities WHERE timestamp >= ?
          GROUP BY DATE(timestamp) ORDER BY day
        `).all(cutoff) as Array<{ day: string; count: number }>;

        trend = db.prepare(`
          SELECT DATE(timestamp) as day, COUNT(*) as count,
                 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
                 SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) as errors
          FROM activities WHERE timestamp >= datetime('now', '-7 days')
          GROUP BY DATE(timestamp) ORDER BY day DESC
        `).all() as Array<{ day: string; count: number; success: number; errors: number }>;

        hourly = db.prepare(`
          SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
          FROM activities WHERE timestamp >= datetime('now', '-30 days')
          GROUP BY hour ORDER BY count DESC LIMIT 24
        `).all() as Array<{ hour: string; count: number }>;
      } finally {
        db.close();
      }
    }

    return NextResponse.json({ ...out, heatmap, trend, hourly, derived });
  } catch (error) {
    console.error('[activities/stats] Error:', error);
    return NextResponse.json({ error: 'Failed to get stats' }, { status: 500 });
  }
}
