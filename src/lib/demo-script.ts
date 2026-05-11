/**
 * Scripted demo arc for RoomPulse.
 *
 * Drives a roughly 20-minute product readiness meeting about RoomPulse itself:
 * browser mic capture, local transcription accuracy, speaker clustering,
 * heartbeat latency, markdown review quality, and session export.
 *
 * The transcript is intentionally paced like a room conversation: frequent
 * turns, clarifying questions, pauses, and decisions unfold over minutes.
 */

export interface DemoBeat {
  /** Milliseconds from the start of the demo. */
  delayMs: number;
  speaker: string;
  text: string;
}

export const DEMO_HEARTBEAT_INTERVAL_SECONDS = 30;
export const DEMO_EXPECTED_PARTICIPANTS = 4;

export const DEMO_AGENDA = [
  "Confirm the RoomPulse MVP bar",
  "Resolve transcription and speaker-clustering risks",
  "Lock Pi heartbeat, markdown, and export next steps"
];

export const DEMO_PARTICIPANTS = [
  { name: "Mina", role: "Product" },
  { name: "Jules", role: "Transcription" },
  { name: "Ari", role: "Pi and backend" },
  { name: "Noor", role: "Room UI" }
];

export const DEMO_SCRIPT: DemoBeat[] = [
  {
    delayMs: 8_000,
    speaker: "Speaker 1",
    text: "Let's start the RoomPulse readiness review. The bar for today is not a fake notetaker demo. We need the room display to request the microphone, stream real transcript lines, run a Pi heartbeat, update the markdown review, and end on a review and export page."
  },
  {
    delayMs: 31_000,
    speaker: "Speaker 4",
    text: "I want the room display to feel credible on first glance. The center document needs to look like a real markdown artifact, tables included, and the controls should make it obvious that ending the meeting takes you to the export page."
  },
  {
    delayMs: 58_000,
    speaker: "Speaker 2",
    text: "From the transcription side, the most visible risk is still accuracy. We moved the local engine to a stronger Whisper model, but background noise and speaker clustering can still make everything look like Speaker 1 if the room is noisy."
  },
  {
    delayMs: 83_000,
    speaker: "Speaker 3",
    text: "On the Pi side, I am worried about latency. We tried GPT-5.3 Spark, but the review still felt slow in strict mode. Let's switch the default back to GPT-5.5 with thinking off and verify it with a real heartbeat API call."
  },
  {
    delayMs: 112_000,
    speaker: "Speaker 1",
    text: "So the meeting goal is confirmed: we are deciding whether RoomPulse is usable as a local room facilitator, and we need owners for transcription accuracy, speaker clustering, Pi latency, markdown quality, and the end-of-session export path."
  },
  {
    delayMs: 139_000,
    speaker: "Speaker 4",
    text: "That covers confirming the meeting goal. I want us to avoid abstract launch language and talk directly about what the user will see during the demo."
  },
  {
    delayMs: 166_000,
    speaker: "Speaker 2",
    text: "First concrete issue: the browser must actually ask for microphone permission after the meeting starts. If the user does not see that prompt, they assume the app is broken even if the local transcription server is running."
  },
  {
    delayMs: 195_000,
    speaker: "Speaker 1",
    text: "Agreed. The default mode should be microphone mode, not demo mode, and the status should say whether the browser permission is prompt, granted, denied, or unavailable."
  },
  {
    delayMs: 226_000,
    speaker: "Speaker 2",
    text: "Second issue: the transcript should filter low-energy background noise. We have high-pass filtering, silence trimming, RMS normalization, VAD, and no-speech thresholds, but we should still tell people that clustering is MVP-quality."
  },
  {
    delayMs: 252_000,
    speaker: "Speaker 3",
    text: "The heartbeat should receive latency-bounded context: recent transcript lines, the fresh delta, compact review history, and the current markdown document. That keeps Pi useful without making long meetings slow again."
  },
  {
    delayMs: 283_000,
    speaker: "Speaker 4",
    text: "For the review document, I do not want heartbeat append spam. The agent should rewrite the whole markdown document each time and use strikethrough when a claim or agenda item is replaced."
  },
  {
    delayMs: 314_000,
    speaker: "Speaker 1",
    text: "Let's list the active risks. One, mic permission or local transcription server fails. Two, speaker clustering merges speakers. Three, Pi initialization or heartbeat takes too long. Four, markdown tables or exports render badly."
  },
  {
    delayMs: 343_000,
    speaker: "Speaker 2",
    text: "On speaker clustering, I can tune the distance threshold and feature extraction, but I do not want to claim biometric speaker identification. It should say observed Speaker N clusters and be honest about limitations."
  },
  {
    delayMs: 371_000,
    speaker: "Speaker 4",
    text: "That honesty is important in the UI. Participation should say three of four heard, not Mina did not speak, unless the user explicitly maps clusters to names later."
  },
  {
    delayMs: 402_000,
    speaker: "Speaker 3",
    text: "Maybe we put speaker clustering in the parking lot and focus on the review agent. The review agent is the differentiated part, and it still needs to use the tools correctly."
  },
  {
    delayMs: 431_000,
    speaker: "Speaker 1",
    text: "I do not want to park clustering yet. In a room-visible facilitator, participation nudges are part of the core product. If everything is Speaker 1, the room cannot trust those nudges."
  },
  {
    delayMs: 460_000,
    speaker: "Speaker 2",
    text: "Then I can own the clustering mitigation. I will tune the default threshold, add clearer docs about the limitation, and make sure the transcript service does not reset to Speaker 1 between segments unless it really should."
  },
  {
    delayMs: 489_000,
    speaker: "Speaker 4",
    text: "I can own the UI language around that. The participation card should make it clear that these are observed audio clusters, not verified human identities."
  },
  {
    delayMs: 518_000,
    speaker: "Speaker 1",
    text: "Good. Let's capture that as Speaker 2 owning clustering quality and Speaker 4 owning the UI language. The success condition is that the demo shows multiple speaker clusters and does not overclaim identity."
  },
  {
    delayMs: 548_000,
    speaker: "Speaker 3",
    text: "For Pi latency, I changed the default model back to GPT-5.5 fast. The remaining question is whether we should reuse a session or keep one session per heartbeat for isolation."
  },
  {
    delayMs: 578_000,
    speaker: "Speaker 1",
    text: "For now, keep one session per heartbeat. I would rather have clean isolation and deterministic fallback than a faster path that carries hidden state we cannot inspect."
  },
  {
    delayMs: 607_000,
    speaker: "Speaker 3",
    text: "That means the latency mitigation is model choice, smaller context where safe, and a timeout that surfaces strict Pi errors quickly. GPT-5.5 with thinking off should be the fastest credible path for the room display."
  },
  {
    delayMs: 637_000,
    speaker: "Speaker 4",
    text: "The UI should show that clearly. If the agent is running locally, say Local. If Pi answers, say GPT-5.5 fast. That way people do not confuse fallback output with the actual Pi behavior."
  },
  {
    delayMs: 668_000,
    speaker: "Speaker 1",
    text: "Decision proposal: for the MVP, we accept fresh Pi sessions per heartbeat, switch the default to GPT-5.5 fast, and keep deterministic local fallback when strict mode is not enabled."
  },
  {
    delayMs: 699_000,
    speaker: "Speaker 3",
    text: "I support that. I will own the Pi adapter defaults and tests, including verifying that the review initialization and heartbeat both use the same GPT-5.5 fast default."
  },
  {
    delayMs: 729_000,
    speaker: "Speaker 2",
    text: "On transcription, I will own making the local server setup obvious. If the browser mic is live but the WebSocket service is not running, the status needs to say exactly that."
  },
  {
    delayMs: 758_000,
    speaker: "Speaker 4",
    text: "The center review document still needs attention. Tables were previously showing as plain pipe text. Now that the renderer supports tables, we should include tables in the initialized markdown and make sure they look intentional."
  },
  {
    delayMs: 787_000,
    speaker: "Speaker 1",
    text: "Yes. The review agent should be allowed to use tables for decisions, risks, and owners. The markdown renderer needs fallback repair for imperfect table syntax because agents do not always include separator rows."
  },
  {
    delayMs: 816_000,
    speaker: "Speaker 4",
    text: "I can own the visual polish for the markdown document: table borders, horizontal scroll, and type scale. It should feel like a live working doc, not raw markdown dumped into a card."
  },
  {
    delayMs: 846_000,
    speaker: "Speaker 1",
    text: "Now let's cover persistence. When the meeting ends, the app should mark the SQLite session ended and navigate to the review page with copy transcript, export transcript, and copy latest markdown."
  },
  {
    delayMs: 877_000,
    speaker: "Speaker 3",
    text: "That path exists now, but the label should say End and review. We also need a fallback handoff link in case navigation does not happen immediately after the session state is saved."
  },
  {
    delayMs: 906_000,
    speaker: "Speaker 4",
    text: "The review page should keep the same design style as the room display. It should not feel like a separate admin page or a JSON dump."
  },
  {
    delayMs: 934_000,
    speaker: "Speaker 2",
    text: "For transcript export, the raw transcript should include timestamps and speaker labels exactly as captured. We should not clean it up so much that it stops being the source of truth."
  },
  {
    delayMs: 963_000,
    speaker: "Speaker 1",
    text: "So the export decision is: raw transcript stays raw, latest markdown is the polished review artifact, and both are queryable from SQLite after the meeting ends."
  },
  {
    delayMs: 991_000,
    speaker: "Speaker 3",
    text: "I can own the backend persistence contract. Sessions, transcript lines, review versions, pause state, and ended state should all live in SQLite, not just in browser memory."
  },
  {
    delayMs: 1_019_000,
    speaker: "Speaker 4",
    text: "I want to add one more UI requirement. During setup, we should not preview an auto-updating markdown file while the user is typing. The initial markdown should be generated once from final setup input."
  },
  {
    delayMs: 1_046_000,
    speaker: "Speaker 1",
    text: "Agreed. Start Meeting should make a single initialization API call, use that as version one, then every heartbeat should revise the whole file using the current markdown, bounded recent context, and fresh transcript delta."
  },
  {
    delayMs: 1_074_000,
    speaker: "Speaker 2",
    text: "We've covered transcription and speaker-clustering risks. The remaining work is mostly ownership and making sure the demo behavior matches the actual product expectations."
  },
  {
    delayMs: 1_102_000,
    speaker: "Speaker 3",
    text: "We've also covered Pi heartbeat and review behavior. I will own the GPT-5.5 fast default, the bounded prompt, and the allowed UI tools for markdown, agenda, and reminders."
  },
  {
    delayMs: 1_128_000,
    speaker: "Speaker 4",
    text: "I will own the room UI polish, the markdown table rendering, and the end review page handoff. The reminder should stay quiet and ephemeral, not a big orange card that distracts everyone."
  },
  {
    delayMs: 1_153_000,
    speaker: "Speaker 1",
    text: "Action summary: Speaker 2 owns transcription accuracy and clustering clarity, Speaker 3 owns Pi latency and persistence, Speaker 4 owns markdown rendering and review/export UI, and Speaker 1 owns the final MVP bar."
  },
  {
    delayMs: 1_176_000,
    speaker: "Speaker 1",
    text: "That covers owners and next steps. The next checkpoint is a real local run: mic permission prompt, transcript lines, GPT-5.5 heartbeat, markdown table rendering, and End and review export all working in one pass."
  }
];

export const DEMO_DURATION_MS = 1_200_000;
