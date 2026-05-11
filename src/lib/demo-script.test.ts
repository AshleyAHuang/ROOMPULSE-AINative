import { describe, expect, it } from "vitest";
import { DEMO_SCRIPT } from "./demo-script";

describe("scripted demo", () => {
  it("does not instruct the room to send full transcript context to Pi", () => {
    const scriptText = DEMO_SCRIPT.map((beat) => beat.text).join("\n");

    expect(scriptText).not.toMatch(/full raw transcript/i);
    expect(scriptText).not.toMatch(/full transcript/i);
    expect(scriptText).not.toMatch(/full-context prompt/i);
    expect(scriptText).toMatch(/bounded/i);
  });
});
