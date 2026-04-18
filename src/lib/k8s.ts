/**
 * Kubernetes API client.
 *
 * The sidecar runs inside the openclaw namespace with ServiceAccount "default",
 * which has Role openclaw-self-manage granting pods [get, list] + deployments
 * [get, patch]. We consume the ServiceAccount token mounted at
 * /var/run/secrets/kubernetes.io/serviceaccount and talk to the apiserver.
 */

import { readFileSync, existsSync } from 'fs';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN_FILE = `${SA_DIR}/token`;
const CA_FILE = `${SA_DIR}/ca.crt`;
const NS_FILE = `${SA_DIR}/namespace`;

export function isInCluster(): boolean {
  return existsSync(TOKEN_FILE) && existsSync(CA_FILE);
}

function apiHost(): string {
  const host = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || '443';
  return `https://${host}:${port}`;
}

export function currentNamespace(): string {
  try {
    return readFileSync(NS_FILE, 'utf-8').trim() || 'openclaw';
  } catch {
    return process.env.KUBERNETES_NAMESPACE || 'openclaw';
  }
}

function token(): string {
  try {
    return readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

async function k8sFetch<T>(pathname: string): Promise<T> {
  if (!isInCluster()) {
    throw new Error('Not running inside a Kubernetes cluster (no ServiceAccount)');
  }
  // Node 22+ fetch with a custom CA: the built-in fetch does not easily accept
  // a CA bundle, so we use the NODE_EXTRA_CA_CERTS env var path trick: since
  // we cannot modify it at runtime, we disable TLS verification for the
  // apiserver call only. This is safe because we pin the host to the in-cluster
  // apiserver DNS (kubernetes.default.svc) and send a service-account bearer
  // token — an attacker would need to already be inside the cluster.
  const agent = new (await import('https')).Agent({
    ca: existsSync(CA_FILE) ? readFileSync(CA_FILE) : undefined,
  });

  const url = `${apiHost()}${pathname}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/json',
    },
    // @ts-expect-error — undici accepts `dispatcher`, but for Node 22 built-in
    // fetch we rely on global agent. If CA verification fails in a particular
    // environment, we fall back to the https module below.
    agent,
  }).catch(async () => {
    // Fallback: use the https module directly when fetch cannot wire the custom CA.
    const { request } = await import('https');
    const { URL } = await import('url');
    const u = new URL(url);
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          host: u.hostname,
          port: u.port || 443,
          path: u.pathname + (u.search || ''),
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token()}`,
            Accept: 'application/json',
          },
          ca: existsSync(CA_FILE) ? readFileSync(CA_FILE) : undefined,
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve(
              new Response(body, {
                status: r.statusCode || 500,
                headers: { 'Content-Type': r.headers['content-type']?.toString() || 'application/json' },
              })
            );
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`k8s ${pathname} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface K8sPod {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  status?: {
    phase?: string;
    podIP?: string;
    startTime?: string;
    containerStatuses?: Array<{
      name: string;
      ready: boolean;
      restartCount: number;
      started?: boolean;
      state?: Record<string, unknown>;
      image?: string;
    }>;
  };
  spec?: {
    containers?: Array<{ name: string; image: string }>;
  };
}

export async function listPods(namespace: string = currentNamespace()): Promise<K8sPod[]> {
  const data = await k8sFetch<{ items: K8sPod[] }>(`/api/v1/namespaces/${namespace}/pods`);
  return data.items || [];
}

export async function getPod(name: string, namespace: string = currentNamespace()): Promise<K8sPod> {
  return await k8sFetch<K8sPod>(`/api/v1/namespaces/${namespace}/pods/${name}`);
}

/** Derived pod status: ready/notReady/pending/failed/unknown. */
export function podDisplayStatus(pod: K8sPod): 'active' | 'pending' | 'failed' | 'unknown' {
  const phase = pod.status?.phase;
  if (phase === 'Failed') return 'failed';
  if (phase === 'Pending') return 'pending';
  if (phase === 'Running') {
    const all = pod.status?.containerStatuses || [];
    const ready = all.every((c) => c.ready);
    return ready ? 'active' : 'pending';
  }
  return 'unknown';
}
