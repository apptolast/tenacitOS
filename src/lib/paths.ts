import path from 'path';
import fs from 'fs';

export const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/root/.openclaw';
export const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(OPENCLAW_DIR, 'workspace');
export const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, 'openclaw.json');
export const OPENCLAW_MEDIA = path.join(OPENCLAW_DIR, 'media');

export const WORKSPACE_IDENTITY = path.join(OPENCLAW_WORKSPACE, 'IDENTITY.md');
export const WORKSPACE_TOOLS = path.join(OPENCLAW_WORKSPACE, 'TOOLS.md');
export const WORKSPACE_MEMORY = path.join(OPENCLAW_WORKSPACE, 'memory');

export const SYSTEM_SKILLS_PATH = '/usr/lib/node_modules/openclaw/skills';
export const WORKSPACE_SKILLS_PATH = path.join(OPENCLAW_DIR, 'workspace-infra', 'skills');

export const ALLOWED_MEDIA_PREFIXES = [
  path.join(OPENCLAW_WORKSPACE, '/'),
  path.join(OPENCLAW_MEDIA, '/'),
];

// Persistent data dir for TenacitOS SQLite DBs (activities, usage-tracking, notifications).
// In K8s we point this to the mounted PVC so data survives pod restarts.
// Default outside K8s: <cwd>/data (the ephemeral /app/data inside the container).
export const TENACITOS_DATA_DIR =
  process.env.TENACITOS_DATA_DIR ||
  path.join(process.cwd(), 'data');

export function ensureDataDir(subdir?: string): string {
  const dir = subdir ? path.join(TENACITOS_DATA_DIR, subdir) : TENACITOS_DATA_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function dataFile(name: string): string {
  ensureDataDir();
  return path.join(TENACITOS_DATA_DIR, name);
}

// Host-mounted /proc and /sys for real host metrics (CPU, RAM, net).
// When running as a K8s sidecar we mount /proc and /sys of the host via hostPath.
// When running outside K8s, /host/proc does not exist — we fall back to /proc.
export const HOST_PROC = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';
export const HOST_SYS = fs.existsSync('/host/sys') ? '/host/sys' : '/sys';
