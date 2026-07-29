import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { buildJob, getLatestRun, loadJobs, saveJob } from "@/server/job-storage";
import { getJobScheduler } from "@/server/singleton";

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

  // Shared with the MCP create_job tool so the two cannot drift again.
  const job = buildJob({ ...body, schedules });

  saveJob(job);
  getJobScheduler()?.reloadJobs();

  return NextResponse.json({ job }, { status: 201 });
}
