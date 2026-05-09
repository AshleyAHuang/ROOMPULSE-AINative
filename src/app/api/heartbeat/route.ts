import { NextResponse } from "next/server";
import {
  createHeartbeatInput,
  type CreateHeartbeatInputArgs
} from "@/lib/facilitator";
import { runPiHeartbeat } from "@/lib/pi-adapter";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CreateHeartbeatInputArgs;
    const input = createHeartbeatInput(payload);
    const output = await runPiHeartbeat(input);

    return NextResponse.json(output);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Heartbeat failed"
      },
      { status: 500 }
    );
  }
}
