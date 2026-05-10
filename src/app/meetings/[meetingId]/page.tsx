import { notFound } from "next/navigation";
import { readMeetingLog } from "@/lib/meeting-log-store";
import MeetingReviewClient from "./review-client";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{
    meetingId: string;
  }>;
}

export default async function MeetingReviewPage({ params }: PageProps) {
  const { meetingId } = await params;

  try {
    const snapshot = await readMeetingLog(meetingId);
    return <MeetingReviewClient snapshot={snapshot} />;
  } catch {
    notFound();
  }
}
