import dotenv from "dotenv";
dotenv.config({ override: true });
import React from "react";
import { render } from "ink";
import { Channel } from "./channel.js";
import { LLMClient } from "./llm.js";
import { Agent } from "./agent.js";
import { App } from "./app.js";
import { AGENTS_CONFIG } from "./agents.config.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Missing ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

const channel = new Channel("#dev");
const llm = new LLMClient(apiKey);

for (const config of AGENTS_CONFIG) {
  const agent = new Agent(config, channel, llm);
  channel.join(config.id, `${config.name} (${config.role})`);
  agent.start();
}

render(<App channel={channel} />);
