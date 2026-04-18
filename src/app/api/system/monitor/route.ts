/**
 * System Monitor (K8s-aware).
 *
 * Previously this route shelled out to pm2/systemctl/ufw/tailscale — none of
 * which exist inside the TenacitOS sidecar. We now:
 *
 *  • Read CPU / RAM / network from /host/proc (hostPath mount).
 *  • List the services as Kubernetes pods in the openclaw namespace via the
 *    in-cluster ServiceAccount (Role openclaw-self-manage: pods get/list).
 *  • Return an empty Tailscale block (the previous stack used Tailscale; the
 *    K8s deployment does not — we keep the shape for backward-compat with the
 *    frontend until it is fully migrated).
 *  • Return an empty firewall block for the same reason.
 */
import { NextResponse } from "next/server";
import { readHostCpu, readHostMem, readHostDisk, readHostNet, readHostInfo } from "@/lib/host-metrics";
import { listPods, podDisplayStatus, currentNamespace, isInCluster, K8sPod } from "@/lib/k8s";

interface ServiceEntry {
  name: string;
  status: string;
  description: string;
  backend: string;
  uptime?: number | null;
  restarts?: number;
  pid?: number | null;
  mem?: number | null;
  cpu?: number | null;
  image?: string;
  podIP?: string;
  containers?: number;
  readyContainers?: number;
  /** Container names on this pod. Exposed so the Logs page can pick which
   *  container to stream for multi-container pods (openclaw has 3: openclaw,
   *  tenacitos, gateway-proxy). Without this, the stream defaults to the
   *  first container which may not be what the user wants. */
  containerNames?: string[];
}

function podToService(pod: K8sPod): ServiceEntry {
  const containers = pod.status?.containerStatuses || [];
  const ready = containers.filter((c) => c.ready).length;
  const restarts = containers.reduce((a, c) => a + (c.restartCount || 0), 0);
  const started = pod.status?.startTime ? new Date(pod.status.startTime).getTime() : null;
  const uptime = started ? Date.now() - started : null;
  const primary = containers[0]?.image || pod.spec?.containers?.[0]?.image;
  const containerNames = (pod.spec?.containers || []).map((c) => c.name);
  return {
    name: pod.metadata.name,
    status: podDisplayStatus(pod),
    description: pod.metadata.labels?.["app.kubernetes.io/name"] || pod.metadata.labels?.app || pod.metadata.name,
    backend: "kubernetes",
    uptime,
    restarts,
    pid: null,
    image: primary,
    podIP: pod.status?.podIP,
    containers: containers.length,
    readyContainers: ready,
    containerNames,
  };
}

export async function GET() {
  try {
    const cpuInfo = readHostCpu();
    const mem = readHostMem();
    const disk = await readHostDisk();
    const net = readHostNet();
    const hostInfo = readHostInfo();

    const services: ServiceEntry[] = [];
    let k8sReachable = false;
    if (isInCluster()) {
      try {
        const pods = await listPods(currentNamespace());
        for (const p of pods) services.push(podToService(p));
        k8sReachable = true;
      } catch (err) {
        console.warn("system/monitor: k8s API error", err);
      }
    }

    return NextResponse.json({
      cpu: {
        usage: cpuInfo.usagePercent,
        cores: Array.from({ length: cpuInfo.cores }, () => 0),
        loadAvg: cpuInfo.loadAvg,
      },
      ram: {
        total: mem.totalGb,
        used: mem.usedGb,
        free: mem.freeGb,
        cached: mem.cachedGb,
      },
      disk: {
        total: disk.totalGb,
        used: disk.usedGb,
        free: disk.freeGb,
        percent: disk.percent,
      },
      network: { rx: net.rxMbps, tx: net.txMbps },
      systemd: services, // name kept for frontend backward-compat; items are k8s pods
      kubernetes: {
        reachable: k8sReachable,
        namespace: currentNamespace(),
        pods: services.length,
      },
      host: {
        hostname: hostInfo.hostname,
        kernel: hostInfo.kernel,
        uptimeSeconds: hostInfo.uptimeSeconds,
      },
      // Legacy fields: the K8s deployment does not use Tailscale or UFW;
      // keep the shape so existing frontend code does not crash while a
      // future PR can replace those widgets with Traefik/IngressRoute info.
      tailscale: {
        active: false,
        ip: "",
        devices: [],
      },
      firewall: {
        active: false,
        rules: [],
        ruleCount: 0,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("system/monitor error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch system monitor data",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
