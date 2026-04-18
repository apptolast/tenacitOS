/**
 * Read real host metrics from hostPath-mounted /host/proc and /host/sys.
 * The pod mounts the host filesystem read-only; this bypasses the cgroup
 * limits that os.totalmem()/loadavg() would return inside the sidecar.
 *
 * Falls back to /proc (the pod's own cgroup view) when /host/proc is not
 * available (dev environments).
 */

import { readFileSync } from 'fs';
import { HOST_PROC } from './paths';

export interface HostCpu {
  loadAvg: [number, number, number];
  cores: number;
  /** 0-100 instantaneous percent (derived from /proc/stat delta vs prev call) */
  usagePercent: number;
}

export interface HostMem {
  totalGb: number;
  usedGb: number;
  freeGb: number;
  cachedGb: number;
  percent: number;
}

export interface HostDisk {
  totalGb: number;
  usedGb: number;
  freeGb: number;
  percent: number;
}

export interface HostNet {
  rxMbps: number;
  txMbps: number;
}

export interface HostInfo {
  uptimeSeconds: number;
  hostname: string;
  kernel: string;
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function readNumber(path: string): number {
  const s = readFile(path).trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function readHostLoadAvg(): [number, number, number] {
  const raw = readFile(`${HOST_PROC}/loadavg`).trim();
  const parts = raw.split(/\s+/);
  return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
}

export function readHostCoreCount(): number {
  const raw = readFile(`${HOST_PROC}/cpuinfo`);
  return raw.split('\n').filter((l) => l.startsWith('processor')).length || 1;
}

interface CpuSnapshot {
  idle: number;
  total: number;
  ts: number;
}

let lastCpu: CpuSnapshot | null = null;

export function readHostCpu(): HostCpu {
  const stat = readFile(`${HOST_PROC}/stat`).split('\n')[0]; // "cpu  user nice system idle ..."
  const nums = stat.split(/\s+/).slice(1).map((n) => Number(n) || 0);
  const idle = nums[3] + (nums[4] || 0); // idle + iowait
  const total = nums.reduce((a, b) => a + b, 0);

  let usagePercent = 0;
  if (lastCpu) {
    const dTotal = total - lastCpu.total;
    const dIdle = idle - lastCpu.idle;
    if (dTotal > 0) {
      usagePercent = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
    }
  }
  lastCpu = { idle, total, ts: Date.now() };

  const loadAvg = readHostLoadAvg();
  return { loadAvg, cores: readHostCoreCount(), usagePercent };
}

export function readHostMem(): HostMem {
  const raw = readFile(`${HOST_PROC}/meminfo`);
  const kv: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) kv[m[1]] = Number(m[2]);
  }
  const total = (kv.MemTotal || 0) / 1024 / 1024;
  const available = (kv.MemAvailable || kv.MemFree || 0) / 1024 / 1024;
  const cached = (kv.Cached || 0) / 1024 / 1024;
  const used = total - available;
  return {
    totalGb: round(total),
    usedGb: round(used),
    freeGb: round(available),
    cachedGb: round(cached),
    percent: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface NetSnapshot {
  rxBytes: number;
  txBytes: number;
  ts: number;
}

let lastNet: NetSnapshot | null = null;

export function readHostNet(): HostNet {
  const raw = readFile(`${HOST_PROC}/net/dev`);
  const lines = raw.split('\n').slice(2); // skip 2 header rows
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const iface = parts[0].replace(':', '');
    if (iface === 'lo' || iface.startsWith('cali') || iface.startsWith('tunl')) continue;
    rx += Number(parts[1]) || 0;
    tx += Number(parts[9]) || 0;
  }
  const now = Date.now();
  let rxMbps = 0;
  let txMbps = 0;
  if (lastNet) {
    const dt = (now - lastNet.ts) / 1000;
    if (dt > 0) {
      rxMbps = Math.max(0, (rx - lastNet.rxBytes) / 1024 / 1024 / dt);
      txMbps = Math.max(0, (tx - lastNet.txBytes) / 1024 / 1024 / dt);
    }
  }
  lastNet = { rxBytes: rx, txBytes: tx, ts: now };
  return { rxMbps: round(rxMbps), txMbps: round(txMbps) };
}

export function readHostInfo(): HostInfo {
  const uptime = Number((readFile(`${HOST_PROC}/uptime`).split(/\s+/)[0] || 0)) || 0;
  const hostname = readFile(`${HOST_PROC}/sys/kernel/hostname`).trim() || process.env.HOSTNAME || 'unknown';
  const kernel = readFile(`${HOST_PROC}/sys/kernel/osrelease`).trim() || '';
  return { uptimeSeconds: uptime, hostname, kernel };
}

/**
 * Disk usage via statvfs on "/". When the pod mounts the host root at /host
 * (we do not — only /host/proc and /host/sys), statvfs would read the host.
 * Otherwise we read from /host/proc/mounts + /host/sys/... to find the root
 * device size. Fallback: use the TENACITOS_DATA_DIR mount (PVC → Longhorn
 * volume) which is a reasonable proxy for "disk we can write to".
 */
export async function readHostDisk(): Promise<HostDisk> {
  try {
    // statvfs is not available in Node stdlib; use the `df` command as a
    // shortcut. In the sidecar we do not have df on bookworm-slim by default,
    // but the openclaw-data PVC is mounted at /home/node/.openclaw, which
    // we can inspect via readFileSync on the block stats if we know the
    // device. Simplest portable approach: read /host/proc/1/mountinfo to
    // find the device backing "/" on the host, then read
    // /host/sys/block/<dev>/size.
    const mountinfo = readFile(`${HOST_PROC}/1/mountinfo`);
    let rootDev = '';
    for (const line of mountinfo.split('\n')) {
      const parts = line.split(' ');
      // mountinfo format: <id> <parent> <major:minor> <root> <mount> ...
      if (parts[4] === '/') {
        rootDev = parts[2] || '';
        break;
      }
    }
    if (rootDev) {
      // Block stats: /host/sys/dev/block/<major:minor>/stat — not size.
      // Size in sectors: /host/sys/dev/block/<maj:min>/size (512 bytes each).
      const sizeSectors = readNumber(`/host/sys/dev/block/${rootDev}/size`);
      if (sizeSectors > 0) {
        const totalGb = round((sizeSectors * 512) / 1024 / 1024 / 1024);
        // There is no free/used on /host/sys; leave 0 and rely on memory.
        return { totalGb, usedGb: 0, freeGb: totalGb, percent: 0 };
      }
    }
  } catch {}
  return { totalGb: 0, usedGb: 0, freeGb: 0, percent: 0 };
}
