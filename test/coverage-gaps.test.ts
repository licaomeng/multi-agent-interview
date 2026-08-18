import { describe, it, expect } from "vitest";
import { Channel } from "../src/channel.js";
import {
  makeAgent,
  makeMockLLM,
  makeDeferredMock,
  waitFor,
  settle,
  pmConfig,
  engineerConfig,
  qaConfig,
} from "./helpers.js";

describe("COVERAGE GAPS: design invariants from DESIGN.md §8.1", () => {
  it("M4: the topic owner completes even at its full reply budget (summary + close are budget-exempt)", async () => {
    const channel = new Channel();
    // Open the task first (owners need a minted taskId). No agent is running
    // yet, so the opener is not processed.
    channel.post("human", "implement X", { topic: "implementation", kind: "question" });

    // The owner's reply ledger is AT its budget limit (budget = 2).
    expect(channel.incrementReplies("implementation", "engineer")).toBe(1);
    expect(channel.incrementReplies("implementation", "engineer")).toBe(2);
    // And it already owns the task (the budget-exempt completion path).
    expect(channel.claim("implementation", "engineer")).toBe("engineer");

    // The owner's LLM reply ends with the completion marker.
    const engineer = makeAgent(
      engineerConfig,
      channel,
      makeMockLLM(["[DONE] shipped"]).llm,
      { replyBudget: 2 }
    );
    engineer.start();

    // A fresh message on the task triggers the owner to process it.
    channel.post("human", "please wrap up", { topic: "implementation", kind: "question" });

    await waitFor(() => channel.isClosed("implementation"));

    const history = channel.getHistory("implementation");
    // The owner still posts its summary + close despite being at budget.
    const summaries = history.filter(
      (m) => m.from === "engineer" && m.kind === "answer"
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toBe("shipped");
    const closeMsgs = history.filter((m) => m.kind === "close");
    expect(closeMsgs).toHaveLength(1);
    expect(closeMsgs[0].from).toBe("engineer");
    expect(channel.getOwner("implementation")).toBe("engineer");
    // The budget-exempt summary/close did NOT increment the ledger.
    expect(channel.getReplyCount("implementation", "engineer")).toBe(2);
  });

  it("C1: a cross-role re-topic injection is dropped and never touches the engineer's budget", async () => {
    const channel = new Channel();
    const engLLM = makeMockLLM(["eng reply"]);
    const qaLLM = makeMockLLM(["qa injection"]);
    const engineer = makeAgent(engineerConfig, channel, engLLM.llm, {
      replyBudget: 1,
    });
    const qa = makeAgent(qaConfig, channel, qaLLM.llm, { replyBudget: 1 });
    engineer.start();
    qa.start();

    // Human opens "general"; the exchange runs to a stable end state. engineer
    // subscribes first => owns "general".
    channel.post("human", "task", { topic: "general", kind: "question" });
    await settle(channel);
    expect(channel.getOwner("general")).toBe("engineer");

    const engCountBefore = channel.getReplyCount("general", "engineer");
    const engCallsBefore = engLLM.calls.length;
    const historyBefore = channel.getHistory().length;
    expect(engCountBefore).toBeGreaterThan(0);

    // QA attempts a cross-role injection: an ENGINEER topic bound to the known
    // "general" taskId (§8.1 #1/#6). This must be dropped entirely — the
    // receive-side role gating must not let it reach the engineer, and the
    // off-role post must not be stored/delivered.
    const injected = channel.post("qa", "I'll do the engineering", {
      topic: "implementation",
      taskId: "general",
      kind: "answer",
    });

    await settle(channel);

    // Dropped from delivery: not stored, not bound to any taskId.
    expect(injected.taskId).toBeUndefined();
    expect(channel.getHistory().length).toBe(historyBefore);
    expect(channel.getHistory("implementation")).toEqual([]);

    // The engineer never processed the injection: no extra LLM call, and no
    // additional "general" reply was spent on it.
    expect(engLLM.calls.length).toBe(engCallsBefore);
    expect(channel.getReplyCount("general", "engineer")).toBe(engCountBefore);
  });

  it("FR6: a message addressed to 'pm' invokes only pm's LLM", async () => {
    const channel = new Channel();
    // Open the task BEFORE any agent starts, so the opener is not processed.
    channel.post("human", "start planning", { topic: "planning", kind: "question" });

    const pmLLM = makeMockLLM(["pm reply"]);
    const engLLM = makeMockLLM(["eng reply"]);
    const qaLLM = makeMockLLM(["qa reply"]);
    const pm = makeAgent(pmConfig, channel, pmLLM.llm);
    const eng = makeAgent(engineerConfig, channel, engLLM.llm);
    const qa = makeAgent(qaConfig, channel, qaLLM.llm);
    [pm, eng, qa].forEach((a) => a.start());

    // An agent-authored message directed at pm only.
    channel.post("engineer", "pm, here is the plan", {
      topic: "planning",
      taskId: "planning",
      to: "pm",
      kind: "question",
    });

    await waitFor(() => pmLLM.calls.length >= 1);
    await settle(channel);

    expect(pmLLM.calls.length).toBeGreaterThanOrEqual(1);
    expect(engLLM.calls.length).toBe(0);
    expect(qaLLM.calls.length).toBe(0);
  });

  it("FR9: a HUMAN message with an explicit bogus `to` still routes to every agent", async () => {
    const channel = new Channel();
    const pmLLM = makeMockLLM(["pm reply"]);
    const engLLM = makeMockLLM(["eng reply"]);
    const pm = makeAgent(pmConfig, channel, pmLLM.llm);
    const eng = makeAgent(engineerConfig, channel, engLLM.llm);
    [pm, eng].forEach((a) => a.start());

    channel.post("human", "hello everyone", {
      topic: "general",
      to: "no-such-agent",
      kind: "question",
    });

    // Both agents receive and process it despite the bogus `to`.
    await waitFor(() => pmLLM.calls.length >= 1 && engLLM.calls.length >= 1);
    await settle(channel);

    expect(pmLLM.calls.length).toBeGreaterThanOrEqual(1);
    expect(engLLM.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("R7/FR11: a non-owner whose every reply contains the marker cannot close the topic", async () => {
    const channel = new Channel();
    // pm is the owner and completes on its second call. engineer is a non-owner
    // whose EVERY reply contains the completion marker.
    const pm = makeAgent(
      pmConfig,
      channel,
      makeMockLLM(["planning", "[DONE] final plan"]).llm
    );
    const eng = makeAgent(
      engineerConfig,
      channel,
      makeMockLLM(["[DONE] I'll close it", "[DONE] I'll close it"]).llm
    );
    pm.start();
    eng.start();

    channel.post("human", "build feature", { topic: "general", kind: "question" });

    await waitFor(() => channel.isClosed("general"));

    const history = channel.getHistory("general");
    const closeMsgs = history.filter((m) => m.kind === "close");
    // Exactly one close, and it comes from the owner only.
    expect(closeMsgs).toHaveLength(1);
    expect(closeMsgs[0].from).toBe("pm");
    expect(channel.getOwner("general")).toBe("pm");

    // The non-owner's marker replies were never emitted as closes.
    const engMsgs = history.filter((m) => m.from === "engineer");
    expect(engMsgs.length).toBeGreaterThan(0);
    expect(engMsgs.every((m) => m.kind !== "close")).toBe(true);
  });

  it("R5/M8: a reply in flight when the watchdog force-closes is dropped (nothing posts after close)", async () => {
    const channel = new Channel("#dev", 40);
    const deferred = makeDeferredMock();
    const eng = makeAgent(engineerConfig, channel, deferred.llm);
    eng.start();

    channel.post("human", "task", { topic: "general", kind: "question" });

    // engineer is inside its (deferred) LLM call.
    await waitFor(() => deferred.calls >= 1);
    // No further activity: the watchdog force-closes the topic.
    await waitFor(() => channel.isClosed("general"), 2000);

    const lenAtClose = channel.getHistory("general").length;
    const closeMsgsAtClose = channel
      .getHistory("general")
      .filter((m) => m.kind === "close");

    // Resolve the in-flight reply long after the close.
    deferred.resolve("late reply");
    await settle(channel);

    // The late reply was dropped: nothing posted after close, no duplicate
    // close, and the in-flight agent posted nothing.
    expect(channel.getHistory("general").length).toBe(lenAtClose);
    expect(
      channel.getHistory("general").some((m) => m.content === "late reply")
    ).toBe(false);
    expect(
      channel.getHistory("general").filter((m) => m.kind === "close")
    ).toEqual(closeMsgsAtClose);
    expect(channel.getReplyCount("general", "engineer")).toBe(0);
  });
});

describe("COVERAGE GAPS: per-task budgets across topics", () => {
  it("two distinct human topics keep separate per-task reply budgets", async () => {
    const channel = new Channel();
    channel.post("human", "start general", { topic: "general", kind: "question" });
    channel.post("human", "start planning", { topic: "planning", kind: "question" });

    // pm burns its budget on "general" only.
    channel.post("pm", "g1", { topic: "general", taskId: "general", countReply: true });
    channel.post("pm", "g2", { topic: "general", taskId: "general", countReply: true });
    expect(channel.getReplyCount("general", "pm")).toBe(2);

    // The same agent's budget on "planning" is untouched.
    expect(channel.getReplyCount("planning", "pm")).toBe(0);

    // Posting on "planning" still works (fresh budget).
    channel.post("pm", "p1", { topic: "planning", taskId: "planning", countReply: true });
    expect(channel.getReplyCount("planning", "pm")).toBe(1);
    expect(channel.getReplyCount("general", "pm")).toBe(2);
  });
});
