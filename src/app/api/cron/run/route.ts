/**
 * Manually trigger a cron job.
 *
 * The gateway does not currently expose a REST endpoint for this, and the
 * `openclaw cron run --force` CLI binary is not available in the TenacitOS
 * sidecar. Until OpenClaw exposes a trigger endpoint we return 501 so the
 * UI can surface the limitation clearly instead of showing a fake success.
 */
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.id) {
      return NextResponse.json({ error: "Job ID required" }, { status: 400 });
    }
    return NextResponse.json(
      {
        success: false,
        error:
          "Manual cron trigger is not available from the TenacitOS sidecar yet. Run `openclaw cron run <id> --force` inside the openclaw container or wait for the gateway REST API.",
      },
      { status: 501 }
    );
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
