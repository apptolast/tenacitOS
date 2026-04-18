/**
 * HTTP client for the local OpenClaw Gateway.
 *
 * Why HTTP and not execSync('openclaw ...'): the `openclaw` CLI binary lives in
 * the openclaw container, NOT in the TenacitOS sidecar. Both containers share
 * the pod network namespace, so the sidecar can reach the gateway on
 * http://localhost:18789 (bound to loopback) with the gateway token pulled
 * from the openclaw-credentials Secret.
 */

import { readFileSync } from 'fs';
import { OPENCLAW_CONFIG } from './paths';

const DEFAULT_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';

function getToken(): string {
  // Preferred: injected at runtime by the Deployment from the Secret.
  const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // Fallback for dev: read from openclaw.json gateway.auth.token.
  // In prod the JSON has the unresolved literal "${OPENCLAW_GATEWAY_TOKEN}"
  // — which will fail auth, so this is dev-only.
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    const t = cfg?.gateway?.auth?.token;
    if (typeof t === 'string' && !t.startsWith('${')) return t;
  } catch {}
  return '';
}

export interface GatewayFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  timeoutMs?: number;
  query?: Record<string, string | number | boolean | undefined>;
}

export async function gatewayFetch<T = unknown>(
  pathname: string,
  opts: GatewayFetchOptions = {}
): Promise<T> {
  const token = getToken();
  const url = new URL(pathname, DEFAULT_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);

  try {
    const res = await fetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gateway ${opts.method ?? 'GET'} ${pathname} failed: ${res.status} ${text.slice(0, 200)}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function gatewayHealth(): Promise<{ ok: boolean; status?: string }> {
  try {
    return await gatewayFetch<{ ok: boolean; status?: string }>('/health', { timeoutMs: 2000 });
  } catch {
    return { ok: false };
  }
}
