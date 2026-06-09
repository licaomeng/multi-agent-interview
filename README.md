# Multi-Agent Collaboration Challenge

## Setup

```bash
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm install
npm start
```

This starts a chat channel with one agent (**Alex**, a software engineer). Type messages and Alex will respond. It works great — with one agent.

## Your Challenge

Modify this project so that **3+ agents with different roles** collaborate effectively in the same channel.

For example, you might add:
- A **product manager** who breaks down requirements
- A **code reviewer** who critiques proposals
- A **QA engineer** who thinks about edge cases

### Requirements

Your system should:

1. **Not produce infinite conversation loops** — agents should not endlessly respond to each other
2. **Not duplicate work** — multiple agents should not do the same thing in parallel
3. **Have agents contribute based on their role** — a reviewer should review, not implement
4. **Scale gracefully** — adding a 4th or 5th agent should not break things

### Rules

- You may modify any file
- You may add new files
- You may change the architecture entirely
- You may use any npm packages
- There is no single correct answer — we care about your design thinking and the trade-offs you make

## What You're Given

```
src/
  types.ts      # Message and AgentConfig types
  channel.ts    # Shared message bus — post, subscribe, getHistory
  llm.ts        # Thin Anthropic SDK wrapper
  agent.ts      # Single agent: listens to channel, responds via LLM
  main.ts       # Boots 1 agent, accepts human input via CLI
```

The architecture is intentionally minimal. The `Channel` broadcasts every message to every subscriber (except the sender). The `Agent` responds to every message it receives. This works fine with one agent.

With multiple agents, you'll quickly discover why this is a hard problem.

## Hints (read only if stuck)

<details>
<summary>What goes wrong with naive multi-agent?</summary>

If you just create 3 agents and subscribe them all to the channel:
- Agent A responds to the human
- Agent B sees A's response and responds
- Agent C sees B's response and responds
- Agent A sees C's response and responds
- ... infinite loop

</details>

<details>
<summary>Possible approaches (there are many more)</summary>

- Have each agent decide whether a message is relevant to its role before responding
- Introduce a coordinator that decides who should speak
- Add a cooldown or turn-taking mechanism
- Let agents address each other explicitly (@name)
- Set response budgets per "round"
- Build a task queue where agents claim work

Each approach has trade-offs. That's the point.

</details>

## Time Expectation

This is designed for a **2-3 hour** working session. A working (even if imperfect) solution that demonstrates clear thinking about the coordination problem is better than a perfect but unfinished architecture.
