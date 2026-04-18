import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { OPENCLAW_WORKSPACE, WORKSPACE_IDENTITY, OPENCLAW_CONFIG, OPENCLAW_DIR } from '@/lib/paths';
import { readHostMem, readHostInfo } from '@/lib/host-metrics';
import { gatewayHealth } from '@/lib/gateway';

const WORKSPACE_PATH = OPENCLAW_WORKSPACE;
const IDENTITY_PATH = WORKSPACE_IDENTITY;

function parseIdentityMd(): { name: string; creature: string; emoji: string } {
  try {
    const content = fs.readFileSync(IDENTITY_PATH, 'utf-8');
    const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
    const creatureMatch = content.match(/\*\*Creature:\*\*\s*(.+)/);
    const emojiMatch = content.match(/\*\*Emoji:\*\*\s*(.+)/);
    return {
      name: nameMatch?.[1]?.trim() || process.env.NEXT_PUBLIC_AGENT_NAME || 'TenacitOS',
      creature: creatureMatch?.[1]?.trim() || 'AI Agent',
      emoji: emojiMatch?.[1]?.match(/./u)?.[0] || process.env.NEXT_PUBLIC_AGENT_EMOJI || '🦞',
    };
  } catch {
    return {
      name: process.env.NEXT_PUBLIC_AGENT_NAME || 'TenacitOS',
      creature: 'AI Agent',
      emoji: process.env.NEXT_PUBLIC_AGENT_EMOJI || '🦞',
    };
  }
}

interface Integration {
  id: string;
  name: string;
  status: 'connected' | 'disconnected' | 'configured' | 'not_configured';
  icon: string;
  lastActivity: string | null;
  detail: string | null;
}

async function getIntegrationStatus(): Promise<Integration[]> {
  const integrations: Integration[] = [];
  let config: Record<string, unknown> | null = null;
  try {
    config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
  } catch {
    // config unreadable — all integrations will be reported as disconnected
  }

  // Telegram
  const telegramCfg = (config?.channels as Record<string, unknown> | undefined)?.telegram as
    | Record<string, unknown>
    | undefined;
  const telegramEnabled = telegramCfg ? !!(telegramCfg.enabled ?? true) : false;
  const telegramAccounts = telegramCfg?.accounts
    ? Object.keys(telegramCfg.accounts as Record<string, unknown>).length
    : 0;
  const telegramPluginEnabled = !!(
    config?.plugins as Record<string, unknown> | undefined
  )?.entries
    ? !!(((config?.plugins as Record<string, unknown>)?.entries as Record<string, unknown>)
        ?.telegram as Record<string, unknown> | undefined)?.enabled
    : false;
  const telegramLive = telegramEnabled && telegramPluginEnabled;
  integrations.push({
    id: 'telegram',
    name: 'Telegram',
    status: telegramLive ? 'connected' : telegramEnabled ? 'configured' : 'not_configured',
    icon: 'MessageCircle',
    lastActivity: telegramLive ? new Date().toISOString() : null,
    detail: telegramAccounts ? `${telegramAccounts} bots configured` : null,
  });

  // Discord
  const discordCfg = (config?.channels as Record<string, unknown> | undefined)?.discord as
    | Record<string, unknown>
    | undefined;
  const discordEnabled = discordCfg ? !!(discordCfg.enabled ?? true) : false;
  const discordPluginEnabled = !!((
    (config?.plugins as Record<string, unknown> | undefined)?.entries as Record<string, unknown> | undefined
  )?.discord as Record<string, unknown> | undefined)?.enabled;
  const discordLive = discordEnabled && discordPluginEnabled;
  integrations.push({
    id: 'discord',
    name: 'Discord',
    status: discordLive ? 'connected' : discordEnabled ? 'configured' : 'not_configured',
    icon: 'MessageSquare',
    lastActivity: discordLive ? new Date().toISOString() : null,
    detail: null,
  });

  // Gateway health (is the OpenClaw gateway reachable?)
  const gw = await gatewayHealth();
  integrations.push({
    id: 'gateway',
    name: 'OpenClaw Gateway',
    status: gw.ok ? 'connected' : 'disconnected',
    icon: 'Server',
    lastActivity: gw.ok ? new Date().toISOString() : null,
    detail: gw.ok ? 'loopback :18789' : 'unreachable',
  });

  // Twitter (bird CLI) — check TOOLS.md
  let twitterConfigured = false;
  try {
    const toolsPath = path.join(WORKSPACE_PATH, 'TOOLS.md');
    const toolsContent = fs.readFileSync(toolsPath, 'utf-8');
    twitterConfigured = toolsContent.includes('bird') && toolsContent.includes('auth_token');
  } catch {}
  integrations.push({
    id: 'twitter',
    name: 'Twitter (bird CLI)',
    status: twitterConfigured ? 'configured' : 'not_configured',
    icon: 'Twitter',
    lastActivity: null,
    detail: null,
  });

  // Google (gog) — check plugins + config dir
  let googleConfigured = false;
  let googleDetail: string | null = null;
  try {
    const gogPlugin = (
      (config?.plugins as Record<string, unknown> | undefined)?.entries as
        | Record<string, unknown>
        | undefined
    )?.['google-gemini-cli-auth'] as Record<string, unknown> | undefined;
    googleConfigured = !!gogPlugin?.enabled;
    if (googleConfigured) googleDetail = 'google-gemini-cli-auth plugin enabled';
  } catch {}
  integrations.push({
    id: 'google',
    name: 'Google (GOG)',
    status: googleConfigured ? 'configured' : 'not_configured',
    icon: 'Mail',
    lastActivity: null,
    detail: googleDetail,
  });

  return integrations;
}

function getModel(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    const primary = cfg?.agents?.defaults?.model?.primary as string | undefined;
    if (primary) return primary;
  } catch {}
  return process.env.OPENCLAW_MODEL || process.env.DEFAULT_MODEL || 'unknown';
}

export async function GET() {
  const identity = parseIdentityMd();
  const uptime = process.uptime();
  const hostInfo = readHostInfo();
  const hostMem = readHostMem();
  const model = getModel();

  const systemInfo = {
    agent: {
      name: identity.name,
      creature: identity.creature,
      emoji: identity.emoji,
    },
    system: {
      // Pod (sidecar) uptime — useful to correlate with rollouts
      uptime: Math.floor(uptime),
      uptimeFormatted: formatUptime(uptime),
      // Host uptime — real server uptime (read from /host/proc)
      hostUptime: hostInfo.uptimeSeconds,
      hostUptimeFormatted: formatUptime(hostInfo.uptimeSeconds),
      nodeVersion: process.version,
      model,
      workspacePath: OPENCLAW_DIR,
      platform: os.platform(),
      hostname: hostInfo.hostname || os.hostname(),
      kernel: hostInfo.kernel,
      memory: {
        total: hostMem.totalGb * 1024 * 1024 * 1024,
        free: hostMem.freeGb * 1024 * 1024 * 1024,
        used: hostMem.usedGb * 1024 * 1024 * 1024,
      },
    },
    integrations: await getIntegrationStatus(),
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(systemInfo);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${Math.floor(seconds)}s`);
  return parts.join(' ');
}
