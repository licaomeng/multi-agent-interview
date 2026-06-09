import dotenv from "dotenv";
dotenv.config({ override: true });
import React from "react";
import { render } from "ink";
import { Channel } from "./channel.js";
import { LLMClient } from "./llm.js";
import { Agent } from "./agent.js";
import { App } from "./app.js";
import type { AgentConfig } from "./types.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Missing ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

const channel = new Channel("#dev");
const llm = new LLMClient(apiKey);

const agentConfig: AgentConfig = {
  id: "agent-1",
  name: "Alex",
  role: "engineer",
  systemPrompt: [
    "You are Alex, a helpful software engineer participating in a team chat channel called #dev.",
    "You collaborate with humans (and potentially other agents) to accomplish tasks.",
    "Keep your responses concise and focused. When given a task, break it down and work through it step by step.",
    "You see messages in the format '[sender]: message'. Respond naturally as a teammate.",
    "Do NOT prefix your response with your name — the system adds that automatically.",
  ].join("\n"),
};

const agent = new Agent(agentConfig, channel, llm);
channel.join(agentConfig.id, `${agentConfig.name} (${agentConfig.role})`);
agent.start();

render(<App channel={channel} />);
