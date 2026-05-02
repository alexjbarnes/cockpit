import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { validateSession } from "@/server/auth";
import { getLatestRun, loadJobs, saveJob } from "@/server/job-storage";
import { getJobScheduler } from "@/server/singleton";
import type { ScheduledJob } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const jobs = loadJobs().map((job) => {
    const latest = getLatestRun(job.id);
    return {
      ...job,
      lastRunStatus: latest?.status,
      lastRunAt: latest?.startedAt,
      lastRunError: latest?.error,
    };
  });
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const schedules = body.schedules?.length ? body.schedules : body.schedule ? [body.schedule] : [];
  if (!body.name || !body.prompt || schedules.length === 0) {
    return NextResponse.json({ error: "name, prompt, and at least one schedule are required" }, { status: 400 });
  }

  const now = Date.now();
  const job: ScheduledJob = {
    id: uuidv4(),
    name: body.name,
    schedule: schedules[0],
    schedules,
    prompt: body.prompt,
    cwd: body.cwd || "",
    enabled: body.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    model: body.model,
    thinkingLevel: body.thinkingLevel,
    allowedTools: body.allowedTools,
    mcpServers: body.mcpServers,
    mcpToolFilters: body.mcpToolFilters,
    bypassPermissions: body.bypassPermissions ?? false,
    maxDurationMinutes: body.maxDurationMinutes ?? 30,
    retentionDays: body.retentionDays ?? 90,
    skipIfMissed: body.skipIfMissed ?? false,
  };

  saveJob(job);
  getJobScheduler()?.reloadJobs();

  return NextResponse.json({ job }, { status: 201 });
}
