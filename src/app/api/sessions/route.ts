/**
 * Sessions API
 * GET /api/sessions          → list all sessions (from gateway HTTP API)
 * GET /api/sessions?id=xxx   → get messages from a specific session (reads JSONL from PVC)
 *
 * The previous implementation shelled out to `openclaw sessions list`, which
 * is not available in the TenacitOS sidecar. We now reach the gateway on
 * http://localhost:18789 (shared pod netns) using the OPENCLAW_GATEWAY_TOKEN.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { OPENCLAW_DIR, OPENCLAW_CONFIG } from '@/lib/paths';
import { gatewayFetch } from '@/lib/gateway';

interface RawSession {
  key: string;
  kind?: string;
  updatedAt: number;
  ageMs?: number;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  agentId?: string;
  label?: string;
}

interface ParsedSession {
  id: string;
  key: string;
  agentId: string;
  type: 'main' | 'cron' | 'subagent' | 'direct' | 'unknown';
  typeLabel: string;
  typeEmoji: string;
  sessionId: string | null;
  cronJobId?: string;
  subagentId?: string;
  updatedAt: number;
  ageMs: number;
  model: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextUsedPercent: number | null;
  aborted: boolean;
  label?: string;
}

function parseSessionKey(key: string): {
  agentId: string;
  type: 'main' | 'cron' | 'subagent' | 'direct' | 'unknown';
  typeLabel: string;
  typeEmoji: string;
  cronJobId?: string;
  subagentId?: string;
  isRunEntry: boolean;
} {
  // Expected shapes:
  // agent:<agentId>:main
  // agent:<agentId>:cron:<jobId>
  // agent:<agentId>:cron:<jobId>:run:<sessionId>
  // agent:<agentId>:subagent:<subagentId>
  // agent:<agentId>:telegram:<chatId>
  // agent:<agentId>:discord:channel:<channelId>
  const parts = key.split(':');
  const agentId = parts[1] || 'main';

  if (parts.includes('run')) {
    return { agentId, type: 'unknown', typeLabel: 'Run Entry', typeEmoji: '🔁', isRunEntry: true };
  }

  if (parts[2] === 'main') {
    return { agentId, type: 'main', typeLabel: 'Main Session', typeEmoji: '🦞', isRunEntry: false };
  }

  if (parts[2] === 'cron') {
    return {
      agentId,
      type: 'cron',
      typeLabel: 'Cron Job',
      typeEmoji: '🕐',
      cronJobId: parts[3],
      isRunEntry: false,
    };
  }

  if (parts[2] === 'subagent') {
    return {
      agentId,
      type: 'subagent',
      typeLabel: 'Sub-agent',
      typeEmoji: '🤖',
      subagentId: parts[3],
      isRunEntry: false,
    };
  }

  return {
    agentId,
    type: 'direct',
    typeLabel: parts[2] ? `${parts[2].charAt(0).toUpperCase() + parts[2].slice(1)} Chat` : 'Direct Chat',
    typeEmoji: '💬',
    isRunEntry: false,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('id');
  if (sessionId) return getSessionMessages(sessionId);
  return listSessions();
}

async function fetchSessionsFromGateway(): Promise<RawSession[]> {
  const candidates = ['/api/sessions', '/api/v1/sessions', '/sessions'];
  let lastErr: unknown = null;
  for (const p of candidates) {
    try {
      const data = await gatewayFetch<unknown>(p, { timeoutMs: 6000 });
      if (Array.isArray(data)) return data as RawSession[];
      const anyData = data as { sessions?: RawSession[]; items?: RawSession[]; byAgent?: Array<{ recent?: RawSession[] }> };
      if (anyData?.sessions) return anyData.sessions;
      if (anyData?.items) return anyData.items;
      // openclaw status json shape: { sessions: { byAgent: [ { agentId, recent: [] } ] } }
      if (anyData?.byAgent) {
        const flat: RawSession[] = [];
        for (const g of anyData.byAgent) {
          for (const r of g.recent || []) flat.push(r);
        }
        return flat;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

async function listSessions(): Promise<NextResponse> {
  try {
    const rawSessions = await fetchSessionsFromGateway();
    const sessions: ParsedSession[] = [];
    const now = Date.now();

    for (const raw of rawSessions) {
      const parsed = parseSessionKey(raw.key);
      if (parsed.isRunEntry || parsed.type === 'unknown') continue;

      const totalTokens = raw.totalTokens || 0;
      const contextTokens = raw.contextTokens || 0;
      const contextUsedPercent =
        contextTokens > 0 && raw.totalTokensFresh
          ? Math.round((totalTokens / contextTokens) * 100)
          : null;

      sessions.push({
        id: raw.key,
        key: raw.key,
        agentId: raw.agentId || parsed.agentId,
        type: parsed.type,
        typeLabel: parsed.typeLabel,
        typeEmoji: parsed.typeEmoji,
        sessionId: raw.sessionId || null,
        cronJobId: parsed.cronJobId,
        subagentId: parsed.subagentId,
        updatedAt: raw.updatedAt,
        ageMs: raw.ageMs ?? Math.max(0, now - raw.updatedAt),
        model: raw.model || 'unknown',
        modelProvider: raw.modelProvider || defaultProvider(),
        inputTokens: raw.inputTokens || 0,
        outputTokens: raw.outputTokens || 0,
        totalTokens,
        contextTokens,
        contextUsedPercent,
        aborted: raw.abortedLastRun || false,
        label: raw.label,
      });
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return NextResponse.json({ sessions, total: sessions.length });
  } catch (error) {
    console.error('[sessions] Error listing sessions:', error);
    return NextResponse.json(
      {
        error: 'Failed to list sessions',
        detail: error instanceof Error ? error.message : String(error),
        sessions: [],
      },
      { status: 502 }
    );
  }
}

function defaultProvider(): string {
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    const primary: string | undefined = cfg?.agents?.defaults?.model?.primary;
    if (primary && primary.includes('/')) return primary.split('/')[0];
  } catch {}
  return 'unknown';
}

interface JsonlLine {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
    timestamp?: number;
  };
  provider?: string;
  modelId?: string;
  customType?: string;
  data?: unknown;
}

function findSessionFile(sessionId: string): string | null {
  // Sessions can live under any agent workspace: agents/<agentId>/sessions/<uuid>.jsonl
  const agentsDir = join(OPENCLAW_DIR, 'agents');
  if (!existsSync(agentsDir)) return null;
  for (const agentId of readdirSync(agentsDir)) {
    const p = join(agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

async function getSessionMessages(sessionId: string): Promise<NextResponse> {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  const filePath = findSessionFile(sessionId);
  if (!filePath) {
    return NextResponse.json({ error: 'Session not found', messages: [] }, { status: 404 });
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    interface ParsedMessage {
      id: string;
      type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'model_change' | 'system';
      role?: string;
      content: string;
      timestamp: string;
      model?: string;
      toolName?: string;
    }

    const messages: ParsedMessage[] = [];
    let currentModel = '';

    for (const line of lines) {
      try {
        const obj: JsonlLine = JSON.parse(line);
        if (obj.type === 'model_change' && obj.modelId) currentModel = obj.modelId;
        if (obj.type !== 'message' || !obj.message) continue;

        const msg = obj.message;
        const role = msg.role;
        const timestamp = obj.timestamp || new Date().toISOString();

        if (typeof msg.content === 'string') {
          messages.push({
            id: obj.id || Math.random().toString(),
            type: role === 'user' ? 'user' : 'assistant',
            role,
            content: msg.content,
            timestamp,
            model: currentModel || undefined,
          });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              messages.push({
                id: (obj.id || '') + '-text',
                type: role === 'user' ? 'user' : 'assistant',
                role,
                content: block.text,
                timestamp,
                model: currentModel || undefined,
              });
            } else if (block.type === 'tool_use' && block.name) {
              messages.push({
                id: block.id || (obj.id || '') + '-tool',
                type: 'tool_use',
                role,
                content: `${block.name}(${block.input ? JSON.stringify(block.input).slice(0, 200) : ''})`,
                timestamp,
                toolName: block.name,
                model: currentModel || undefined,
              });
            } else if (block.type === 'tool_result') {
              const resultContent = Array.isArray(block.text)
                ? (block.text as Array<{ type: string; text?: string }>)
                    .map((b) => b.text || '')
                    .join('\n')
                : (block.text as string) || '';
              messages.push({
                id: (obj.id || '') + '-result',
                type: 'tool_result',
                role,
                content: resultContent.slice(0, 500),
                timestamp,
                model: currentModel || undefined,
              });
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return NextResponse.json({ sessionId, messages, total: messages.length });
  } catch (error) {
    console.error('[sessions] Error reading session file:', error);
    return NextResponse.json(
      { error: 'Failed to read session', messages: [] },
      { status: 500 }
    );
  }
}
