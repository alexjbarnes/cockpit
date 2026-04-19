import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { isAuthDisabled, validateSession } from "@/server/auth";
import { loadJobs, saveJob } from "@/server/job-storage";
import { getJobScheduler } from "@/server/singleton";
import type { ScheduledJob } from "@/types";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const jobs = loadJobs();
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  if (!body.name || !body.prompt || !body.cwd || !body.schedule) {
    return NextResponse.json({ error: "name, prompt, cwd, and schedule are required" }, { status: 400 });
  }

  const now = Date.now();
  const job: ScheduledJob = {
    id: uuidv4(),
    name: body.name,
    schedule: body.schedule,
    prompt: body.prompt,
    cwd: body.cwd,
    enabled: body.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    model: body.model,
    allowedTools: body.allowedTools,
    mcpServers: body.mcpServers,
    bypassPermissions: body.bypassPermissions ?? false,
    maxDurationMinutes: body.maxDurationMinutes ?? 30,
    retentionDays: body.retentionDays ?? 90,
    skipIfMissed: body.skipIfMissed ?? false,
  };

  saveJob(job);
  getJobScheduler()?.reloadJobs();

  return NextResponse.json({ job }, { status: 201 });
}
