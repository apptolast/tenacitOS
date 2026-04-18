/**
 * Quick Actions API (K8s-native).
 *
 * Supported actions:
 *   - git-status      : run `git status --short` in each workspace repo on the PVC
 *   - restart-gateway : rollout-restart the openclaw deployment via K8s API
 *   - clear-temp      : clean /tmp inside the sidecar + old *.tmp/*.bak in the workspace
 *   - usage-stats     : read /host/proc for CPU/RAM/disk + `du` of the workspace
 *   - heartbeat       : gateway /health + list pod statuses via K8s API
 *
 * Removed (were unusable under K8s): pm2 jlist, systemctl restart,
 * Tailscale/UFW checks, external HTTP pings to domain names.
 */
import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logActivity } from '@/lib/activities-db';
import { readHostCpu, readHostMem, readHostInfo } from '@/lib/host-metrics';
import { listPods, podDisplayStatus, currentNamespace, isInCluster } from '@/lib/k8s';
import { gatewayHealth } from '@/lib/gateway';
import { OPENCLAW_WORKSPACE } from '@/lib/paths';
import { readFileSync, existsSync } from 'fs';

const execAsync = promisify(exec);

const WORKSPACE = OPENCLAW_WORKSPACE;

interface ActionResult {
  action: string;
  status: 'success' | 'error';
  output: string;
  duration_ms: number;
  timestamp: string;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const CA_FILE = `${SA_DIR}/ca.crt`;
const TOKEN_FILE = `${SA_DIR}/token`;

async function rolloutRestartOpenclaw(): Promise<string> {
  if (!isInCluster()) return 'Not running inside K8s — cannot restart deployment';
  const { request } = await import('https');
  const { URL } = await import('url');
  const host = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443';
  const ns = currentNamespace();
  const url = new URL(`https://${host}:${port}/apis/apps/v1/namespaces/${ns}/deployments/openclaw`);
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf-8').trim() : '';
  const ca = existsSync(CA_FILE) ? readFileSync(CA_FILE) : undefined;
  const body = JSON.stringify({
    spec: {
      template: {
        metadata: {
          annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
        },
      },
    },
  });

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        path: url.pathname,
        method: 'PATCH',
        ca,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/strategic-merge-patch+json',
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode || 500;
          if (status >= 300) {
            reject(new Error(`K8s ${status}: ${Buffer.concat(chunks).toString('utf-8').slice(0, 200)}`));
            return;
          }
          resolve('Rollout restart of deployment/openclaw triggered');
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runAction(action: string): Promise<ActionResult> {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  try {
    let output = '';

    switch (action) {
      case 'git-status': {
        const { stdout: dirs } = await execAsync(
          `find "${WORKSPACE}" -maxdepth 3 -name ".git" -type d 2>/dev/null | head -10`
        );
        const repoPaths = dirs
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((d) => d.replace('/.git', ''));
        if (repoPaths.length === 0) {
          output = 'No git repos found in workspace';
          break;
        }
        const results: string[] = [];
        for (const repoPath of repoPaths) {
          const name = repoPath.split('/').pop() || repoPath;
          try {
            const { stdout: status } = await execAsync(
              `cd "${repoPath}" && git status --short 2>&1 && echo "---" && git log --oneline -3 2>&1`
            );
            results.push(`📁 ${name}:\n${status || '(clean)'}`);
          } catch {
            results.push(`📁 ${name}: (error reading git status)`);
          }
        }
        output = results.join('\n\n');
        break;
      }

      case 'restart-gateway': {
        output = await rolloutRestartOpenclaw();
        break;
      }

      case 'clear-temp': {
        const commands = [
          'find /tmp -maxdepth 1 -type f -mtime +1 -delete 2>/dev/null; echo "Cleaned sidecar /tmp"',
          `find "${WORKSPACE}" -name "*.tmp" -o -name "*.bak" 2>/dev/null | head -20 | xargs rm -f 2>/dev/null; echo "Cleaned tmp/bak in workspace"`,
        ];
        const results = await Promise.all(
          commands.map((cmd) => execAsync(cmd).then((r) => r.stdout).catch((e) => e.message))
        );
        output = results.join('\n');
        break;
      }

      case 'usage-stats': {
        const cpu = readHostCpu();
        const mem = readHostMem();
        const host = readHostInfo();
        const { stdout: du } = await execAsync(
          `du -sh "${WORKSPACE}" 2>/dev/null || echo "N/A"`
        ).catch(() => ({ stdout: 'N/A' }));
        output =
          `Host: ${host.hostname} (${host.kernel})\n` +
          `Host uptime: ${Math.floor(host.uptimeSeconds / 3600)}h\n\n` +
          `CPU: ${cpu.usagePercent}% (load ${cpu.loadAvg.map((n) => n.toFixed(2)).join(', ')}) — ${cpu.cores} cores\n\n` +
          `RAM: ${mem.usedGb.toFixed(2)} / ${mem.totalGb.toFixed(2)} GB (${mem.percent}% used, cached ${mem.cachedGb.toFixed(2)} GB)\n\n` +
          `Workspace: ${du.trim()}`;
        break;
      }

      case 'heartbeat': {
        const gw = await gatewayHealth();
        const lines: string[] = [];
        lines.push(`${gw.ok ? '✅' : '❌'} OpenClaw Gateway: ${gw.status || (gw.ok ? 'live' : 'unreachable')}`);
        if (isInCluster()) {
          try {
            const pods = await listPods(currentNamespace());
            for (const p of pods) {
              const st = podDisplayStatus(p);
              const icon = st === 'active' ? '✅' : st === 'pending' ? '⏳' : '❌';
              lines.push(`${icon} ${p.metadata.name}: ${st}`);
            }
          } catch (e) {
            lines.push(`⚠️ K8s API error: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          lines.push('⚠️ Not running inside a Kubernetes cluster');
        }
        output = lines.join('\n');
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const duration_ms = Date.now() - start;
    logActivity('command', `Quick action: ${action}`, 'success', {
      duration_ms,
      metadata: { action },
    });
    return { action, status: 'success', output, duration_ms, timestamp };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    logActivity('command', `Quick action failed: ${action}`, 'error', {
      duration_ms,
      metadata: { action, error: errMsg },
    });
    return { action, status: 'error', output: errMsg, duration_ms, timestamp };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;
    if (!action) {
      return NextResponse.json({ error: 'Missing action' }, { status: 400 });
    }
    const validActions = ['git-status', 'restart-gateway', 'clear-temp', 'usage-stats', 'heartbeat'];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `Unknown action. Valid: ${validActions.join(', ')}` },
        { status: 400 }
      );
    }
    const result = await runAction(action);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[actions] Error:', error);
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}
