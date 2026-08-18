import { describe, it, expect } from "vitest";
import { mergeConsecutiveRoles } from "../src/agent.js";

describe("mergeConsecutiveRoles (behavior preserved)", () => {
  it("merges consecutive same-role messages with a newline", () => {
    const out = mergeConsecutiveRoles([
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a1" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "u1\nu2" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("coerces a leading assistant turn to user (API requirement)", () => {
    const out = mergeConsecutiveRoles([
      { role: "assistant", content: "a1" },
      { role: "user", content: "u1" },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "a1" });
    expect(out[1]).toEqual({ role: "user", content: "u1" });
  });

  it("returns [] for empty input", () => {
    expect(mergeConsecutiveRoles([])).toEqual([]);
  });

  it("does not merge across different roles", () => {
    const out = mergeConsecutiveRoles([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
    expect(out.length).toBe(3);
  });
});
