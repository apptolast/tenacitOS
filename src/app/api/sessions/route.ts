/**
 * Sessions API
 *
 * The OpenClaw gateway does not expose a JSON REST API for sessions — the
 * `/sessions` HTTP path serves the Control UI (HTML). To avoid shelling out
 * to the `openclaw` CLI (not installed in the TenacitOS sidecar), we scan
 * the PVC directly: session state lives as JSONL files under
 * /home/node/.openclaw/agents/<agentId>/sessions/<uuid>.jsonl.
 *
 * The JSONL format starts with a session descriptor record and then logs
 * each message. The last line's timestamp approximates the session's
 * updatedAt; token counts are parsed from the most recent `message` entry
 * that carries a usage block (if present).
 */
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { OPENCLAW_DIR } from '@/lib/paths';

interface ParsedSession {
  id: string;
  key: string;
  agentId: string;
  type: 'main' | 'cron' | 'subagent' | 'direct' | 'unknown';
  typeLabel: string;
  typeEmoji: string;
  sessionId: string;
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
  fileSizeBytes: number;
}

interface SessionDescriptor {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  kind?: string;
  parent?: { kind?: string; jobId?: string; subagentId?: string; channel?: string; chatId?: string };
  label?: string;
}

interface ModelChange {
  type: string;
  provider?: string;
  modelId?: string;
}

interface TailEntry {
  type?: string;
  timestamp?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  data?: { usage?: { input?: number; output?: number } };
}

/**
 * Read the first line and the tail (last ~4KB) of a JSONL file without
 * loading the full file into memory. Session files can grow to MB.
 */
function readHeadAndTail(filePath: string): { head: string; tail: string } {
  const fd = openSync(filePath, 'r');
  try {
    const st = statSync(filePath);
    const size = st.size;
    const headBuf = Buffer.alloc(Math.min(4096, size));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    const tailSize = Math.min(8192, size);
    const tailBuf = Buffer.alloc(tailSize);
    readSync(fd, tailBuf, 0, tailBuf.length, size - tailSize);
    return { head: headBuf.toString('utf-8'), tail: tailBuf.toString('utf-8') };
  } finally {
    closeSync(fd);
  }
}

function parseLastJsonlEntry<T>(tail: string): T | null {
  const lines = tail.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as T;
    } catch {
      // skip partial trailing line
    }
  }
  return null;
}

function parseFirstJsonlEntry<T>(head: string): T | null {
  const first = head.split('\n')[0]?.trim();
  if (!first) return null;
  try {
    return JSON.parse(first) as T;
  } catch {
    return null;
  }
}

function deriveTypeFromDescriptor(desc: SessionDescriptor | null): {
  type: ParsedSession['type'];
  typeLabel: string;
  typeEmoji: string;
  cronJobId?: string;
  subagentId?: string;
} {
  const kind = desc?.kind || desc?.parent?.kind;
  if (kind === 'cron') {
    return {
      type: 'cron',
      typeLabel: 'Cron Job',
      typeEmoji: '🕐',
      cronJobId: desc?.parent?.jobId,
    };
  }
  if (kind === 'subagent') {
    return {
      type: 'subagent',
      typeLabel: 'Sub-agent',
      typeEmoji: '🤖',
      subagentId: desc?.parent?.subagentId,
    };
  }
  if (kind === 'telegram' || kind === 'discord' || kind === 'direct') {
    return {
      type: 'direct',
      typeLabel: `${kind.charAt(0).toUpperCase() + kind.slice(1)} Chat`,
      typeEmoji: '💬',
    };
  }
  return { type: 'main', typeLabel: 'Main Session', typeEmoji: '🦞' };
}

function buildKey(agentId: string, parts: ReturnType<typeof deriveTypeFromDescriptor>, sessionId: string): string {
  switch (parts.type) {
    case 'cron':
      return `agent:${agentId}:cron:${parts.cronJobId || sessionId}`;
    case 'subagent':
      return `agent:${agentId}:subagent:${parts.subagentId || sessionId}`;
    case 'direct':
      return `agent:${agentId}:direct:${sessionId}`;
    default:
      return `agent:${agentId}:main`;
  }
}

function parseSessionFile(
  agentId: string,
  filePath: string
): ParsedSession | null {
  try {
    const st = statSync(filePath);
    const { head, tail } = readHeadAndTail(filePath);
    const descriptor = parseFirstJsonlEntry<SessionDescriptor>(head);
    const last = parseLastJsonlEntry<TailEntry>(tail);

    const sessionId = descriptor?.id || filePath.split('/').pop()?.replace(/\.jsonl$/, '') || '';
    const updatedAt = last?.timestamp ? new Date(last.timestamp).getTime() : st.mtime.getTime();

    // Scan head for first model_change record (usually second line)
    let model = 'unknown';
    let modelProvider = 'unknown';
    for (const line of head.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as ModelChange;
        if (obj.type === 'model_change' && obj.modelId) {
          model = obj.modelId;
          modelProvider = obj.provider || 'unknown';
          break;
        }
      } catch {
        /* skip */
      }
    }

    // Token accumulation: scan tail for usage blocks
    let inputTokens = 0;
    let outputTokens = 0;
    for (const line of tail.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as TailEntry;
        const usage = obj?.message?.usage || obj?.data?.usage;
        if (usage) {
          const input = (usage as { input_tokens?: number; input?: number }).input_tokens ??
            (usage as { input?: number }).input ?? 0;
          const output = (usage as { output_tokens?: number; output?: number }).output_tokens ??
            (usage as { output?: number }).output ?? 0;
          inputTokens += input;
          outputTokens += output;
        }
      } catch {
        /* skip */
      }
    }

    const parts = deriveTypeFromDescriptor(descriptor);
    const key = buildKey(agentId, parts, sessionId);

    return {
      id: key,
      key,
      agentId,
      type: parts.type,
      typeLabel: parts.typeLabel,
      typeEmoji: parts.typeEmoji,
      sessionId,
      cronJobId: parts.cronJobId,
      subagentId: parts.subagentId,
      updatedAt,
      ageMs: Math.max(0, Date.now() - updatedAt),
      model,
      modelProvider,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      contextTokens: 0,
      contextUsedPercent: null,
      aborted: false,
      label: descriptor?.label,
      fileSizeBytes: st.size,
    };
  } catch {
    return null;
  }
}

function listAgentIds(): string[] {
  const agentsDir = join(OPENCLAW_DIR, 'agents');
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listSessionFiles(agentId: string): string[] {
  const sessionsDir = join(OPENCLAW_DIR, 'agents', agentId, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  try {
    return readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl')) // skip .deleted, .reset, .bak
      .map((f) => join(sessionsDir, f));
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('id');
  if (sessionId) return getSessionMessages(sessionId);
  return listSessions();
}

function listSessions(): NextResponse {
  const sessions: ParsedSession[] = [];
  for (const agentId of listAgentIds()) {
    for (const file of listSessionFiles(agentId)) {
      const parsed = parseSessionFile(agentId, file);
      if (parsed) sessions.push(parsed);
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return NextResponse.json({ sessions, total: sessions.length });
}

interface JsonlLine {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role: string;
    content:
      | string
      | Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
  };
  modelId?: string;
}

function findSessionFile(sessionId: string): string | null {
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
