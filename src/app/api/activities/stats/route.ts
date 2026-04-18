/**
 * Activity Stats API
 * GET /api/activities/stats
 * Returns heatmap data, counts by type/status, recent trend, and hourly distribution.
 */
import { NextResponse } from 'next/server';
import { getActivityStats } from '@/lib/activities-db';
import Database from 'better-sqlite3';
import fs from 'fs';
import { dataFile } from '@/lib/paths';

export async function GET() {
  try {
    const stats = getActivityStats();
    const DB_PATH = dataFile('activities.db');

    // The DB might not exist yet (fresh PVC). Return empty series rather
    // than 500 so the frontend renders a calm "no activity yet" state.
    if (!fs.existsSync(DB_PATH)) {
      return NextResponse.json({
        ...stats,
        heatmap: [],
        trend: [],
        hourly: [],
      });
    }

    const db = new Database(DB_PATH, { readonly: true });
    try {
      const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const heatmapRows = db.prepare(`
        SELECT DATE(timestamp) as day, COUNT(*) as count
        FROM activities
        WHERE timestamp >= ?
        GROUP BY DATE(timestamp)
        ORDER BY day
      `).all(cutoff) as Array<{ day: string; count: number }>;

      const trendRows = db.prepare(`
        SELECT DATE(timestamp) as day, COUNT(*) as count,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
        FROM activities
        WHERE timestamp >= datetime('now', '-7 days')
        GROUP BY DATE(timestamp)
        ORDER BY day DESC
      `).all() as Array<{ day: string; count: number; success: number; errors: number }>;

      const hourRows = db.prepare(`
        SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
        FROM activities
        WHERE timestamp >= datetime('now', '-30 days')
        GROUP BY hour
        ORDER BY count DESC
        LIMIT 24
      `).all() as Array<{ hour: string; count: number }>;

      return NextResponse.json({
        ...stats,
        heatmap: heatmapRows,
        trend: trendRows,
        hourly: hourRows,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[activities/stats] Error:', error);
    return NextResponse.json({ error: 'Failed to get stats' }, { status: 500 });
  }
}
