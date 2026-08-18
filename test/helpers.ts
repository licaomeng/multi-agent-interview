import { Channel } from "../src/channel.js";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";
import type { LLM, ChatMessage } from "../src/llm.js";
import type { AgentOptions } from "../src/agent.js";

export interface MockLLM {
  llm: LLM;
  calls: { system: string; messages: ChatMessage[] }[];
}

/**
 * A deterministic, scripted LLM mock. Returns script[i] for the i-th call
 * (clamped to the last script entry for calls past the end of the script).
 * With no script, returns "ack" forever.
 */
export function makeMockLLM(script: string[] = []): MockLLM {
  const calls: MockLLM["calls"] = [];
  let i = 0;
  const llm: LLM = {
    chat: async (system, messages) => {
      calls.push({ system, messages: [...messages] });
      const reply =
        script.length > 0 ? script[Math.min(i, script.length - 1)] : "ack";
      i++;
      return reply;
    },
  };
  return { llm, calls };
}

/** An LLM mock whose resolution we control explicitly (for stale-close tests). */
export function makeDeferredMock(): {
  llm: LLM;
  resolve: (value: string) => void;
  calls: number;
} {
  let resolveFn!: (value: string) => void;
  let calls = 0;
  const llm: LLM = {
    chat: async () => {
      calls++;
      return new Promise<string>((r) => {
        resolveFn = r;
      });
    },
  };
  return {
    llm,
    resolve: (value: string) => resolveFn(value),
    get calls() {
      return calls;
    },
  };
}

/** An LLM mock that always throws. */
export function makeThrowingMock(error = new Error("boom")): LLM {
  return {
    chat: async () => {
      throw error;
    },
  };
}

export function makeAgent(
  config: AgentConfig,
  channel: Channel,
  llm: LLM,
  opts: AgentOptions = {}
): Agent {
  return new Agent(config, channel, llm, opts);
}

/** Poll until `cond` is true or the timeout elapses. */
export async function waitFor(
  cond: () => boolean,
  timeoutMs = 3000,
  intervalMs = 5
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

/** Wait until the message history is stable (no new messages) for `quietMs`. */
export async function settle(
  channel: Channel,
  quietMs = 50,
  maxWaitMs = 2000
): Promise<void> {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < maxWaitMs) {
    const n = channel.getHistory().length;
    if (n === last) {
      await new Promise((r) => setTimeout(r, quietMs));
      if (channel.getHistory().length === n) return;
    }
    last = n;
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const pmConfig: AgentConfig = {
  id: "pm",
  name: "Priya",
  role: "pm",
  topics: ["general", "planning", "requirements"],
  systemPrompt: "You are Priya, a product manager.",
};

export const engineerConfig: AgentConfig = {
  id: "engineer",
  name: "Alex",
  role: "engineer",
  topics: ["general", "implementation"],
  systemPrompt: "You are Alex, a software engineer.",
};

export const qaConfig: AgentConfig = {
  id: "qa",
  name: "Maya",
  role: "qa",
  topics: ["general", "testing"],
  systemPrompt: "You are Maya, a QA engineer.",
};

export const reviewerConfig: AgentConfig = {
  id: "reviewer",
  name: "Sam",
  role: "reviewer",
  topics: ["general", "review"],
  systemPrompt: "You are Sam, a code reviewer.",
};
