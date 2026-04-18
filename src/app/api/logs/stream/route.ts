/**
 * Real-time log streaming via SSE — K8s pod logs.
 *
 * GET /api/logs/stream?service=<podName>&container=<containerName>
 *
 * Previously this streamed pm2 or journalctl logs on the host. In K8s we
 * stream the pod's stdout/stderr via the K8s API (follow=true). Only pods
 * in the openclaw namespace are allowed, and the pod list is fetched via
 * the ServiceAccount so there is no way to stream logs from other
 * namespaces.
 */
import { NextRequest } from 'next/server';
import { isInCluster, currentNamespace, listPods } from '@/lib/k8s';
import { readFileSync, existsSync } from 'fs';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const CA_FILE = `${SA_DIR}/ca.crt`;
const TOKEN_FILE = `${SA_DIR}/token`;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const pod = searchParams.get('service') || searchParams.get('pod');
  const container = searchParams.get('container') || undefined;
  const tailLines = Math.min(parseInt(searchParams.get('lines') || '200', 10), 2000);

  if (!pod) {
    return new Response('Missing service/pod parameter', { status: 400 });
  }
  if (!isInCluster()) {
    return new Response('Not in Kubernetes cluster', { status: 503 });
  }

  // Verify the pod exists in our namespace (prevents cross-namespace probing)
  try {
    const pods = await listPods();
    if (!pods.find((p) => p.metadata.name === pod)) {
      return new Response('Pod not found in namespace', { status: 404 });
    }
  } catch (err) {
    return new Response(`K8s error: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }

  const encoder = new TextEncoder();
  const ns = currentNamespace();
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf-8').trim() : '';
  const ca = existsSync(CA_FILE) ? readFileSync(CA_FILE) : undefined;
  const host = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443';
  const qs = new URLSearchParams({
    follow: 'true',
    tailLines: String(tailLines),
    ...(container ? { container } : {}),
  });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: string) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`)
          );
        } catch {}
      };
      send(`[stream] Connected to pod ${pod} (namespace ${ns}${container ? `, container ${container}` : ''})`);

      const { request: httpsRequest } = await import('https');
      const req = httpsRequest(
        {
          host,
          port: Number(port),
          path: `/api/v1/namespaces/${ns}/pods/${pod}/log?${qs.toString()}`,
          method: 'GET',
          ca,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json, text/plain',
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300) {
            send(`[error] K8s ${res.statusCode}`);
            try { controller.close(); } catch {}
            return;
          }
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) if (line) send(line);
          });
          res.on('end', () => {
            if (buffer) send(buffer);
            send('[stream] ended');
            try { controller.close(); } catch {}
          });
        }
      );
      req.on('error', (err) => {
        send(`[error] ${err.message}`);
        try { controller.close(); } catch {}
      });
      req.end();

      request.signal?.addEventListener('abort', () => {
        try { req.destroy(); } catch {}
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
