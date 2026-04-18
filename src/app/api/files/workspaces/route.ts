import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { OPENCLAW_DIR, OPENCLAW_CONFIG } from '@/lib/paths';

interface Workspace {
  id: string;
  name: string;
  emoji: string;
  path: string;
  agentName?: string;
}

interface OpenClawAgentRef {
  id: string;
  name?: string;
  workspace?: string;
  identity?: { name?: string; emoji?: string };
  ui?: { emoji?: string };
}

/**
 * Read openclaw.json and return a map workspacePath → {name, emoji}.
 * We prefer this as source-of-truth over IDENTITY.md because some workspaces
 * in the PVC still carry stale IDENTITY.md from previous deploy iterations
 * (e.g. "Tenacitas", "Kubito"). openclaw.json is rewritten on every deploy.
 */
function loadAgentMeta(): Map<string, { name: string; emoji: string }> {
  const meta = new Map<string, { name: string; emoji: string }>();
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    const defaults = cfg?.agents?.defaults;
    for (const agent of (cfg?.agents?.list || []) as OpenClawAgentRef[]) {
      const ws = agent.workspace || defaults?.workspace;
      if (!ws) continue;
      const name = agent.name || agent.identity?.name || agent.id;
      const emoji = agent.identity?.emoji || agent.ui?.emoji || '🤖';
      meta.set(ws, { name, emoji });
    }
    // Also map the "main" workspace (the defaults.workspace path) if not already.
    if (defaults?.workspace && !meta.has(defaults.workspace)) {
      meta.set(defaults.workspace, {
        name: process.env.NEXT_PUBLIC_AGENT_NAME || 'TenacitOS',
        emoji: process.env.NEXT_PUBLIC_AGENT_EMOJI || '🦞',
      });
    }
  } catch {
    // Config unreadable — fall back to IDENTITY.md / directory name
  }
  return meta;
}

function getAgentInfoFromIdentity(workspacePath: string): { name: string; emoji: string } | null {
  const identityPath = path.join(workspacePath, 'IDENTITY.md');
  if (!fs.existsSync(identityPath)) return null;
  try {
    const content = fs.readFileSync(identityPath, 'utf-8');
    const nameMatch = content.match(/- \*\*Name:\*\* (.+)/);
    const emojiMatch = content.match(/- \*\*Emoji:\*\* (.+)/);
    const emojiText = emojiMatch?.[1]?.trim() || '';
    return {
      name: nameMatch?.[1]?.trim() || '',
      emoji: emojiText.split(' ')[0] || '📁',
    };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const byPath = new Map<string, Workspace>();
    const agentMeta = loadAgentMeta();

    const mainWorkspace = path.join(OPENCLAW_DIR, 'workspace');
    if (fs.existsSync(mainWorkspace)) {
      const configMeta = agentMeta.get(mainWorkspace);
      const identityMeta = configMeta ? null : getAgentInfoFromIdentity(mainWorkspace);
      const resolved = configMeta || identityMeta || { name: 'Workspace', emoji: '🦞' };
      byPath.set(mainWorkspace, {
        id: 'workspace',
        name: 'Workspace Principal',
        emoji: resolved.emoji,
        path: mainWorkspace,
        agentName: resolved.name,
      });
    }

    // Collect all workspaces referenced by openclaw.json first — these are
    // the canonical ones with correct name/emoji.
    for (const [workspacePath, meta] of agentMeta.entries()) {
      if (byPath.has(workspacePath)) continue;
      if (!fs.existsSync(workspacePath)) continue;
      const agentId =
        path.basename(workspacePath).replace(/^workspace-/, '') || 'workspace';
      byPath.set(workspacePath, {
        id: path.basename(workspacePath),
        name: meta.name,
        emoji: meta.emoji,
        path: workspacePath,
        agentName: meta.name,
      });
      // best-effort ref to avoid linter noise
      void agentId;
    }

    // Finally, any workspace-* dir present on disk but NOT in openclaw.json
    // is shown with a neutral label (legacy/orphan workspace).
    for (const entry of fs.readdirSync(OPENCLAW_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('workspace-')) continue;
      const workspacePath = path.join(OPENCLAW_DIR, entry.name);
      if (byPath.has(workspacePath)) continue;
      const identityMeta = getAgentInfoFromIdentity(workspacePath);
      const agentId = entry.name.replace('workspace-', '');
      byPath.set(workspacePath, {
        id: entry.name,
        name: identityMeta?.name || agentId.charAt(0).toUpperCase() + agentId.slice(1),
        emoji: identityMeta?.emoji || '🤖',
        path: workspacePath,
        agentName: identityMeta?.name || undefined,
      });
    }

    const workspaces = Array.from(byPath.values()).sort((a, b) => {
      if (a.id === 'workspace') return -1;
      if (b.id === 'workspace') return 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ workspaces });
  } catch (error) {
    console.error('Failed to list workspaces:', error);
    return NextResponse.json({ workspaces: [] }, { status: 500 });
  }
}
