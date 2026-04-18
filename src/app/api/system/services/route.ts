/**
 * Pod actions API (K8s-native).
 *
 * POST /api/system/services
 * Body: { name, backend, action }  — backend is ignored; all actions target pods
 * action: restart | logs
 *
 * - "restart": triggers a rollout restart via K8s API (patches deployment template
 *   annotation). Only the deployment name is accepted (allowlist).
 * - "logs": returns the last N log lines of a container via the K8s API.
 *
 * start/stop are not exposed for K8s resources — you scale the Deployment
 * replicas up/down instead. Not supported here by design.
 */
import { NextRequest, NextResponse } from "next/server";
import { isInCluster, currentNamespace } from "@/lib/k8s";
import { readFileSync, existsSync } from "fs";

const ALLOWED_DEPLOYMENTS = ["openclaw", "code-server", "kubikobot", "kubikobot-meetings"];

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const CA_FILE = `${SA_DIR}/ca.crt`;
const TOKEN_FILE = `${SA_DIR}/token`;

async function k8sRequest(
  path: string,
  method: "GET" | "PATCH" | "POST" | "PUT" = "GET",
  body?: unknown,
  contentType?: string
): Promise<{ status: number; body: string }> {
  const { request } = await import("https");
  const { URL } = await import("url");
  const host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || "443";
  const url = new URL(`https://${host}:${port}${path}`);
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf-8").trim() : "";
  const ca = existsSync(CA_FILE) ? readFileSync(CA_FILE) : undefined;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        path: url.pathname + (url.search || ""),
        method,
        ca,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": contentType || "application/json" } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 500,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function rolloutRestart(deployment: string): Promise<string> {
  const ns = currentNamespace();
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
          },
        },
      },
    },
  };
  const r = await k8sRequest(
    `/apis/apps/v1/namespaces/${ns}/deployments/${deployment}`,
    "PATCH",
    patch,
    "application/strategic-merge-patch+json"
  );
  if (r.status >= 300) throw new Error(`K8s ${r.status}: ${r.body.slice(0, 200)}`);
  return `rollout restart of deployment/${deployment} in namespace ${ns} triggered`;
}

async function getPodLogs(podName: string, container?: string, lines = 200): Promise<string> {
  const ns = currentNamespace();
  const qs = new URLSearchParams({ tailLines: String(lines), ...(container ? { container } : {}) });
  const r = await k8sRequest(
    `/api/v1/namespaces/${ns}/pods/${podName}/log?${qs.toString()}`
  );
  if (r.status >= 300) throw new Error(`K8s ${r.status}: ${r.body.slice(0, 200)}`);
  return r.body;
}

export async function POST(request: NextRequest) {
  try {
    const { name, action } = await request.json();
    if (!name || !action) {
      return NextResponse.json({ error: "Missing name or action" }, { status: 400 });
    }
    if (!isInCluster()) {
      return NextResponse.json(
        { error: "Not running inside a Kubernetes cluster — pod actions unavailable" },
        { status: 503 }
      );
    }

    if (action === "logs") {
      // `name` is a pod name (UI passes the pod name from the monitor list).
      const output = await getPodLogs(name, undefined, 200);
      return NextResponse.json({ success: true, output, action, name, backend: "kubernetes" });
    }

    if (action === "restart") {
      // Map a pod name → deployment by stripping the ReplicaSet + pod suffix.
      // Deployment names are in an allowlist so users cannot restart arbitrary
      // deployments.
      const deployment = name.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5,10}$/, "");
      if (!ALLOWED_DEPLOYMENTS.includes(deployment)) {
        return NextResponse.json(
          { error: `Deployment "${deployment}" not in allowlist` },
          { status: 403 }
        );
      }
      const output = await rolloutRestart(deployment);
      return NextResponse.json({ success: true, output, action, name, backend: "kubernetes" });
    }

    return NextResponse.json({ error: `Unsupported action "${action}"` }, { status: 400 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("system/services error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
