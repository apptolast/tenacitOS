/**
 * Lightweight system stats for the status bar.
 * Reports host CPU/RAM/disk and the count of ready pods in the openclaw namespace.
 */
import { NextResponse } from "next/server";
import { readHostCpu, readHostMem, readHostDisk, readHostInfo } from "@/lib/host-metrics";
import { listPods, podDisplayStatus, currentNamespace, isInCluster } from "@/lib/k8s";

export async function GET() {
  try {
    const cpuInfo = readHostCpu();
    const mem = readHostMem();
    const disk = await readHostDisk();
    const host = readHostInfo();

    let activeServices = 0;
    let totalServices = 0;
    if (isInCluster()) {
      try {
        const pods = await listPods(currentNamespace());
        totalServices = pods.length;
        activeServices = pods.filter((p) => podDisplayStatus(p) === "active").length;
      } catch (err) {
        console.warn("system/stats: k8s API error", err);
      }
    }

    const uptimeSeconds = host.uptimeSeconds;
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const uptime = `${days}d ${hours}h`;

    return NextResponse.json({
      cpu: cpuInfo.usagePercent,
      ram: { used: mem.usedGb, total: mem.totalGb },
      disk: { used: disk.usedGb, total: disk.totalGb },
      vpnActive: false, // Tailscale decomissioned with the K8s migration
      firewallActive: false,
      activeServices,
      totalServices,
      uptime,
    });
  } catch (error) {
    console.error("system/stats error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch system stats",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
