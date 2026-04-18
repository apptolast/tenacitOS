import { NextRequest, NextResponse } from 'next/server';
import { logActivity, getActivities } from '@/lib/activities-db';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { OPENCLAW_DIR } from '@/lib/paths';

interface DerivedActivity {
  id: string;
  timestamp: string;
  type: string;
  description: string;
  status: string;
  duration_ms: number | null;
  tokens_used: number | null;
  agent: string | null;
  metadata: Record<string, unknown> | null;
}

interface CronRunRecord {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  summary?: string;
  durationMs?: number;
  deliveryStatus?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  provider?: string;
}

/**
 * Fallback when the SQLite activity DB is empty (e.g. fresh pod after a
 * first rollout). We derive recent activities from two on-disk sources:
 *
 *  1. Cron runs: /home/node/.openclaw/cron/runs/<jobId>.jsonl — one record
 *     per job trigger with status/summary/durationMs.
 *  2. Session updates: the latest JSONL mtime under agents/<id>/sessions/
 *     approximates when the agent last exchanged messages.
 */
function deriveFromPvc(limit: number): DerivedActivity[] {
  const out: DerivedActivity[] = [];
  const cronRunsDir = join(OPENCLAW_DIR, 'cron', 'runs');

  // 1. Cron runs
  if (existsSync(cronRunsDir)) {
    try {
      const files = readdirSync(cronRunsDir).filter((f) => f.endsWith('.jsonl'));
      for (const f of files) {
        const jobId = f.replace(/\.jsonl$/, '');
        const path = join(cronRunsDir, f);
        let raw = '';
        try {
          raw = readFileSync(path, 'utf-8');
        } catch {
          continue;
        }
        const lines = raw.trim().split('\n').slice(-10); // last 10 records per job
        for (const line of lines) {
          try {
            const r = JSON.parse(line) as CronRunRecord;
            if (r.action !== 'finished') continue;
            const tokens = (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0);
            out.push({
              id: `cron:${jobId}:${r.ts}`,
              timestamp: new Date(r.ts || Date.now()).toISOString(),
              type: 'cron',
              description: r.summary || `Cron ${jobId} finished (${r.status || 'ok'})`,
              status: r.status === 'ok' ? 'success' : r.status === 'error' ? 'error' : 'success',
              duration_ms: r.durationMs ?? null,
              tokens_used: tokens > 0 ? tokens : null,
              agent: null,
              metadata: {
                jobId,
                model: r.model,
                provider: r.provider,
                deliveryStatus: r.deliveryStatus,
              },
            });
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* ignore cron scan errors */
    }
  }

  // 2. Session file mtimes (last session per agent)
  const agentsDir = join(OPENCLAW_DIR, 'agents');
  if (existsSync(agentsDir)) {
    try {
      for (const agentId of readdirSync(agentsDir)) {
        const sessionsDir = join(agentsDir, agentId, 'sessions');
        if (!existsSync(sessionsDir)) continue;
        let newest: { file: string; mtime: number } | null = null;
        try {
          for (const f of readdirSync(sessionsDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const st = statSync(join(sessionsDir, f));
            if (!newest || st.mtimeMs > newest.mtime) {
              newest = { file: f, mtime: st.mtimeMs };
            }
          }
        } catch {
          continue;
        }
        if (newest) {
          out.push({
            id: `session:${agentId}:${newest.file}`,
            timestamp: new Date(newest.mtime).toISOString(),
            type: 'message',
            description: `${agentId} — last session activity`,
            status: 'success',
            duration_ms: null,
            tokens_used: null,
            agent: agentId,
            metadata: { sessionFile: newest.file },
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out.slice(0, limit);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || undefined;
    const status = searchParams.get('status') || undefined;
    const agent = searchParams.get('agent') || undefined;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;
    const sort = (searchParams.get('sort') || 'newest') as 'newest' | 'oldest';
    const format = searchParams.get('format') || 'json';
    const limit = Math.min(
      parseInt(searchParams.get('limit') || '20'),
      format === 'csv' ? 10000 : 100
    );
    const offset = parseInt(searchParams.get('offset') || '0');

    const result = getActivities({
      type, status, agent, startDate, endDate, sort, limit, offset,
    });

    let activities = result.activities as DerivedActivity[];
    let total = result.total;
    let derived = false;

    // If DB is empty and no filters are set, derive recent activities from
    // cron run logs + session file mtimes so the Activity Log tab is useful
    // immediately after a rollout (SQLite starts empty on fresh PVC state).
    if (total === 0 && !type && !status && !agent && !startDate && !endDate && offset === 0) {
      const fromDisk = deriveFromPvc(limit);
      if (fromDisk.length > 0) {
        activities = fromDisk;
        total = fromDisk.length;
        derived = true;
      }
    }

    if (format === 'csv') {
      const header = 'id,timestamp,type,description,status,duration_ms,tokens_used,agent\n';
      const rows = activities.map((a) =>
        [
          a.id, a.timestamp, a.type,
          `"${(a.description || '').replace(/"/g, '""')}"`,
          a.status, a.duration_ms ?? '', a.tokens_used ?? '',
          a.agent ?? '',
        ].join(',')
      ).join('\n');
      const csv = header + rows;
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="activities-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }

    return NextResponse.json({
      activities, total, limit, offset,
      hasMore: offset + limit < total,
      derived,
    });
  } catch (error) {
    console.error('Failed to get activities:', error);
    return NextResponse.json({ error: 'Failed to get activities' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.type || !body.description || !body.status) {
      return NextResponse.json(
        { error: 'Missing required fields: type, description, status' },
        { status: 400 }
      );
    }
    const validStatuses = ['success', 'error', 'pending', 'running'];
    if (!validStatuses.includes(body.status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      );
    }
    const activity = logActivity(body.type, body.description, body.status, {
      duration_ms: body.duration_ms ?? null,
      tokens_used: body.tokens_used ?? null,
      agent: body.agent ?? null,
      metadata: body.metadata ?? null,
    });
    return NextResponse.json(activity, { status: 201 });
  } catch (error) {
    console.error('Failed to save activity:', error);
    return NextResponse.json({ error: 'Failed to save activity' }, { status: 500 });
  }
}
