import { NextResponse } from "next/server";
import { readMeetingLog } from "@/lib/meeting-log-store";

interface RouteContext {
  params: Promise<{
    meetingId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { meetingId } = await context.params;

  try {
    const meeting = await readMeetingLog(meetingId);
    return NextResponse.json(meeting);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Meeting log not found" },
      { status: 404 }
    );
  }
}
