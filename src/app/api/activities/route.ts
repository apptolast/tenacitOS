import { NextRequest, NextResponse } from 'next/server';
import { logActivity, getActivities } from '@/lib/activities-db';
import { gatewayFetch } from '@/lib/gateway';

interface GatewaySession {
  key?: string;
  agentId?: string;
  model?: string;
  updatedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  label?: string;
}

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

/**
 * When the SQLite DB has no entries yet (e.g. fresh pod after a rollout),
 * derive a read-only activity list from recent gateway sessions so the UI
 * shows something meaningful instead of an empty feed.
 */
async function deriveFromGateway(limit: number): Promise<DerivedActivity[]> {
  const candidates = ['/api/sessions', '/api/v1/sessions'];
  let sessions: GatewaySession[] | null = null;
  for (const p of candidates) {
    try {
      const data = await gatewayFetch<unknown>(p, { timeoutMs: 2500 });
      if (Array.isArray(data)) {
        sessions = data as GatewaySession[];
        break;
      }
      const any = data as { sessions?: GatewaySession[]; items?: GatewaySession[] };
      if (any?.sessions) {
        sessions = any.sessions;
        break;
      }
      if (any?.items) {
        sessions = any.items;
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!sessions) return [];

  return sessions
    .filter((s) => s.updatedAt)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
    .map((s) => {
      const key = s.key || '';
      const parts = key.split(':');
      const agentId = s.agentId || parts[1] || 'main';
      const kind = parts[2] || 'session';
      return {
        id: `derived:${key}`,
        timestamp: new Date(s.updatedAt || Date.now()).toISOString(),
        type: kind === 'cron' ? 'cron' : kind === 'subagent' ? 'agent_action' : 'message',
        description: s.label || `${kind} session on ${agentId}`,
        status: 'success',
        duration_ms: null,
        tokens_used: s.totalTokens ?? null,
        agent: agentId,
        metadata: { model: s.model, key },
      };
    });
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
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), format === 'csv' ? 10000 : 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    const result = getActivities({ type, status, agent, startDate, endDate, sort, limit, offset });

    // If DB is empty and no filters, derive recent activities from gateway sessions.
    let activities = result.activities;
    let total = result.total;
    let derived = false;
    if (total === 0 && !type && !status && !agent && !startDate && !endDate && offset === 0) {
      const fromGw = await deriveFromGateway(limit);
      if (fromGw.length > 0) {
        activities = fromGw;
        total = fromGw.length;
        derived = true;
      }
    }

    if (format === 'csv') {
      const header = 'id,timestamp,type,description,status,duration_ms,tokens_used,agent\n';
      const rows = activities.map((a) => [
        a.id, a.timestamp, a.type,
        `"${(a.description || '').replace(/"/g, '""')}"`,
        a.status, a.duration_ms ?? '', a.tokens_used ?? '',
        a.agent ?? '',
      ].join(',')).join('\n');
      const csv = header + rows;
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="activities-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }

    return NextResponse.json({
      activities,
      total,
      limit,
      offset,
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
