# Multi-Agent Collaboration Challenge — Requirements, Risks & Design

> Fresh analysis of `README.md` + full source (`src/`, 358 lines TS).
> The repo is a coding-challenge skeleton, not a production system. README explicitly says: no single correct answer, ~2–3 hour session, design thinking is what is evaluated.

---

## 1. Context

The starter repo is a **single-agent terminal chat**: one `Agent` ("Alex", engineer) subscribed to a `Channel` bus, answering every message via the Anthropic Messages API. The task is to extend it so **3+ role-based agents** (e.g., PM, code reviewer, QA) collaborate in one channel, without:

- infinite conversation loops,
- duplicate work,
- role-violating contributions,
- breakage when scaling to 4–5 agents.

---

## 2. Requirements (rethought)

### 2.1 Functional Requirements (FR)

| ID | Requirement | Source / rationale | Priority |
|----|-------------|--------------------|----------|
| FR1 | Multiple role-based agents (≥3) operate in one channel | README core proposition | **Must** |
| FR2 | No infinite conversation loops | README explicitly flags this as the naive-extension failure mode | **Must** |
| FR3 | No duplicate work between agents | README (collaboration quality) | **Must** |
| FR4 | No role-violating contributions | README (each agent stays in its lane) | **Must** |
| FR5 | System remains correct and stable at 4–5 agents | README (scaling requirement) | **Must** |
| FR11 | Task lifecycle runs to completion (owner publishes summary + `close`) | README:15 "collaborate effectively" — a *positive* outcome; the negative constraints alone could be met by silence (review finding) | **Must** |
| FR6 | Message routing / addressing by role or `@name` | README hint; replaces today's all-broadcast | **Must** (load-bearing for FR2–FR5; review finding) |
| FR7 | Turn/task coordination (avoid ping-pong) | README hint; termination control | **Must** (load-bearing for FR2–FR5; review finding) |
| FR8 | Bounded responses per agent (reply budget) | README hint; safety net | **Must** (load-bearing for FR2–FR5; review finding) |
| FR9 | Human participation preserved (`human` input) | current app capability, should not regress | **Should** |
| FR10 | Model / token config via env (not hardcoded) | today `llm.ts` hardcodes model | **Could** |

### 2.2 Non-Functional Requirements (NFR)

| ID | Requirement | Rationale / assessment | Priority |
|----|-------------|------------------------|----------|
| NFR1 | Design clarity & extensibility | challenge is scored on design, not features | **Must** |
| NFR2 | Fast bootstrap | `cp .env.example .env → npm install → npm start` already 3 steps; keep it (inferred from README Setup, not an explicit requirement — review finding) | **Should** |
| NFR3 | Bounded LLM cost / context growth | full-history replay grows tokens linearly per turn; needs windowing/summarization | **Should** |
| NFR4 | Robustness under concurrent messages | per-agent serial queue exists; extend to cross-agent safety | **Should** |
| NFR5 | Terminal output readable per role | colored per-agent output exists; keep legible at 4–5 agents | **Should** |
| NFR6 | Testability of collaboration logic | **zero tests today** — loop/dup/role logic is the riskiest, least-verified part | **Should** |
| NFR7 | Streaming responses | currently non-streaming (blocking UX on long replies) | **Could** |
| NFR8 | Security | already met: key via env, no hardcoded secrets, `.env` gitignored | **Met** |

### 2.3 Priority summary (MoSCoW)

- **Must**: FR1–FR5, FR11, NFR1; plus load-bearing mechanisms FR6–FR8 (elevated on review)
- **Should**: FR9, NFR3–NFR6
- **Could**: FR10, NFR7
- **Already met**: NFR8

**Key insight:** FR2, FR3, FR4, FR5 are four symptoms of the *same root cause* — `Channel` broadcasts to every subscriber and `Agent` responds to every message. One coherent routing/coordination design satisfies all four.

---

## 3. Current-state analysis (verified from source)

| Area | Current implementation | Gap vs requirements |
|------|------------------------|---------------------|
| Message bus | `Channel extends EventEmitter`; `post()` stores + delivers to every subscriber **except sender** (`channel.ts:24-28`) | All-broadcast ⇒ loop source; no addressing, no topics |
| Agent | `Agent` subscribes to **all** messages, replies to each (`agent.ts:16-19`); per-agent serial `processing` flag + FIFO queue (`agent.ts:6-32`) | No role gating, no dedup, no termination |
| Prompt / LLM | Full history rebuilt every turn, `[sender]: content`, consecutive roles merged (`agent.ts:34-77`); non-streaming `claude-sonnet-4-20250514`, `max_tokens 1024` (`llm.ts:14-16`) | Context grows unbounded; model hardcoded |
| Roles | `AgentConfig.role` defined (`types.ts:8-13`) but **never read by LLM logic**; only `systemPrompt` drives behavior | `role` is the ready-made hook for FR4/FR6 |
| UI | Ink terminal, per-agent colors assigned on `join` (`app.tsx`) | Minor bug: agents joined before render fall back to cyan |
| Tests | none | NFR6 gap |
| Config | `.env` only `ANTHROPIC_API_KEY`; model hardcoded | FR10 gap |

---

## 4. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| R1 | Infinite conversation loop (A→B→C→A) | High | High | Addressing + reply budget + topic termination (see §5.6) |
| R2 | Duplicate work (multiple agents redo same task) | High | Medium | Topic ownership / task claim (§5.6) |
| R3 | Role violations (agent contributes outside its role) | Medium | Medium | Role-gated routing + role-aware system prompt (§5.4/5.5) |
| R4 | Context/token explosion as history grows | High | Medium | Windowing + summarization (§5.8) |
| R5 | Stalled collaboration (agents waiting, no progress, or deadlock) | Medium | Medium | Coordinator watchdog / human fallback (§5.7) |
| R6 | No automated verification of collaboration logic | High | High | Headless harness + loop/dup/role tests (§5.9) |
| R7 | Non-deterministic LLM behavior (babbling, off-topic) | Medium | Medium | Reply budgets, cooldowns, termination rules |
| R8 | Dependency drift (`@anthropic-ai/sdk 0.39` is an old pin) | Low | Low | Document pin; upgrade optional |

---

## 5. Design proposal

### 5.1 Core ideas

1. **Address every message.** Replace implicit all-broadcast with an explicit envelope: each message has `to` (target agent id / `"channel"`) and `topic` (task identifier). Agents only process what is addressed to them or matches their competency.
2. **Make `role` a first-class routing key.** The unused `AgentConfig.role` becomes the gating field: each agent declares which topics/roles it handles.
3. **Terminate topics explicitly.** A topic has a lifecycle: `open → in-progress → done`. A "task complete" signal (owner publishes summary + closes topic) is the loop-breaker.
4. **Minimal shared state, held by `Channel` only.** Agents stay stateless, but coordination state that must be shared — topic ownership, closed-topic set, per-(taskId, agentId) reply ledger — lives in `Channel` (single owner, accessed synchronously; EventEmitter is single-threaded, so reads are race-free). Routing decisions come from **static config** (senderId → role), never from LLM-authored content. This keeps agents swappable and scales to 4–5 without a central coordinator agent.

### 5.2 Option comparison

| Option | How it stops loops | Pros | Cons |
|--------|-------------------|------|------|
| **A. Central coordinator** — a router agent owns task queue, assigns work, declares completion | Coordinator decides who acts and when | Deterministic; easy to reason about | Single point of failure; bottleneck at 5+ agents; more LLM overhead |
| **B. Decentralized role-gating + addressing** — no coordinator; envelope-based routing, budgets, topic close | Explicit `to` + per-topic reply budget + close signal | Scales naturally; simple; fits current abstractions | Requires discipline in message model; loop safety depends on envelope rules |
| **C. Hybrid (recommended)** — decentralized envelope routing **plus** a light-weight termination rule (topic owner publishes final summary) | Same as B + explicit completion contract | Balances scale and determinism; matches README hints | Slightly more spec than B |

### 5.3 Recommended: Hybrid (C)

Reuse the existing abstractions (`Channel`, `Agent`, `LLMClient`). No new runtime dependencies.

### 5.4 Message model change (`types.ts`)

Extend `Message` (backwards-compatible):

```ts
interface Message {
  id: string;
  timestamp: number;
  from: string;            // agent id or "human"
  content: string;
  // new:
  to: string | "channel";  // target agent id, or broadcast to all
  topic: string;           // task identifier, e.g. "feature-42-design"
  kind: "question" | "answer" | "review" | "announce" | "close";
}
```

- `kind === "close"` on a topic = all agents stop reacting to that topic.
- `to === "channel"` = addressed to anyone whose `role` matches the topic (role-gating filter), not everyone.

### 5.5 Agent behavior changes (`agent.ts`)

1. **Subscribe, but filter.** On each message, ignore if:
   - topic already closed,
   - `to` is another agent,
   - topic is outside the agent's `role` competency (a static per-role topic map, e.g. `engineer → implementation`, `qa → testing`).
2. **Reply budget per topic.** Track per-topic reply count (in-memory map). After N (e.g. 2) replies, the agent stays silent on that topic.
3. **Echo suppression.** Never reply to a message whose `topic` was already concluded by this agent (`topic + myId` dedup set).

### 5.6 Loop & duplication control (FR2, FR3, FR4)

| Problem | Mechanism |
|---------|-----------|
| Infinite loop | Envelope `to`/`topic`/`kind` + reply budget + `close` signal (two independent stop conditions) |
| Duplicate work | Topic ownership: first agent to claim a topic becomes its **owner** (per-topic map, owner publishes the final `close`); others only contribute via `review`/`question` on owner's work |
| Role violations | Role-gated routing (§5.5.1) + role-specific system prompts; the router never delivers an implementation task to QA |
| Scale to 4–5 | Stateless filtering; no global lock; each agent independently decides relevance. O(total) delivery, no N² loop |

### 5.7 Scaling & stall safety (FR5, R5)

- No central coordinator ⇒ no bottleneck; adding agent #5 is just `main.tsx` config + a topic-map entry.
- Stall watchdog: `Channel` tracks last-activity time per topic; if a topic is open but silent for a threshold, a designated agent (or the human) posts a `close`/nudge. Human fallback always allowed (`human` input unchanged).

### 5.8 Context & token control (NFR3)

Keep the full-transcript approach only for short topics. Once a topic's history exceeds a token threshold:

- roll older turns into a one-paragraph summary appended to the next prompt,
- and pass only messages relevant to the current `topic` instead of the whole channel.

This caps per-turn context and keeps cost bounded.

### 5.9 Testability (NFR6) — recommended addition

A headless harness that drives `Channel` + `Agent` without the Ink UI, plus `vitest` (dev-only):

| Test | What it asserts |
|------|-----------------|
| `no-infinite-loop` | Run N agents on a task with mocked LLM; assert bounded message count |
| `no-duplicate-work` | Assert each topic has exactly one owner / one `close` |
| `role-gating` | Assert agent only replies to messages in its role's topic map |
| `budget-enforced` | Assert per-topic reply count ≤ N |

Mock `LLMClient` with scripted replies — no API key needed in tests.

### 5.10 Config (FR10, optional)

`MODEL`, `MAX_TOKENS`, `AGENTS` from `.env`; keep current defaults (`claude-sonnet-4-20250514`, 1024).

---

## 6. Incremental implementation plan

1. **Extend `Message` + `post()`** with optional `to`/`topic`/`kind`, defaults applied inside `channel.post()` (`to:"channel"`, `kind:"announce"`, `topic:"general"`). Touches `types.ts`, `channel.ts:14` (signature + defaults), `agent.ts:49` (echo the topic/kind of the message being replied to), `app.tsx:106` (human default topic). **Not a pure type change** (review finding).
2. **Routing filter in `Agent`** (role map + `to` + closed-topic check) — this alone removes most loops.
3. **Topic ownership + `close`** — kills duplicate work and terminates topics deterministically.
4. **Reply budget** — hard safety net.
5. **Context windowing/summarization** — NFR3.
6. **Headless harness + tests** — verify 1–5.
7. *(optional)* env-based model config.

Each step is independently verifiable and keeps the app runnable (`npm start`) throughout.

---

## 7. Findings

1. **The unused `role` field is the highest-leverage hook** — wiring it into routing satisfies FR1/FR4/FR6 at once.
2. **Broadcast + respond-to-everything is the single root cause** of FR2–FR5; fix the envelope, not the LLM.
3. **The per-agent serial queue is already good** — keep it; add cross-agent rules on top.
4. **Zero tests is the biggest hidden risk** (R6); the challenge's own failure modes (loop/dup) are exactly what a 30-line test harness can catch before a demo.
5. **No new dependencies required** for the core design; everything lives in `channel.ts`/`agent.ts`/`types.ts`.
6. Minor: fix the pre-render `join` color bug (`app.tsx`) and consider the old SDK pin.

---

## 8. Design Review — Multi-Agent Critique (post-write)

Reviewed by 3 parallel critique agents (requirements coverage / design adversary / implementation feasibility) against `README.md` + all 6 source files. Original line references verified accurate; the architecture survives review, but several **load-bearing corrections are required** (they supersede the earlier sections where they conflict).

### 8.1 Consolidated findings & resolutions

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | Critical | `topic` is LLM-authored and mutable → budget/ownership/`close` keyed on it can be bypassed (re-topic ⇒ fresh budget ⇒ loop resumes) | Mint a fixed `taskId` once (human or claiming owner); non-owners may NOT open new topics; key the reply ledger by `(taskId, agentId)`, never by an envelope string |
| 2 | Critical | Sender-exclusion (`channel.ts:24-28`) means a budget counted on receipt never increments → loop runs to LLM context limits | Count replies at **post time** (channel-side ledger or agent-side before `channel.post`), never in the receive filter |
| 3 | Critical | "No global lock" makes topic claims racy at 4–5 agents → two owners, duplicate work, double `close` | `Channel` exposes atomic `claim(taskId) → ownerId`; claim runs synchronously before the agent's first `await` (EventEmitter is single-threaded, so this is race-free) |
| 4 | Major | Budget can deadlock the owner before it publishes `close`; a failed/crashed owner never releases the topic | `close` + owner's final summary are **exempt** from budget; Channel-side force-close timeout; ownership released on LLM error (`agent.ts:50-52`) |
| 5 | Major | Human input (`app.tsx:106`) bypasses the envelope → either dropped (FR9 regression) or unrouted broadcast | Route all `"human"` messages to every agent regardless of role; default `topic:"general"` |
| 6 | Major | `kind`/`topic` are advisory LLM-authored fields → role gating built on them is soft-bypassable | Role gating derives from **static config** (senderId → role), never from message content |
| 7 | Major | Envelope change is NOT a pure type change: `post()` signature + 3 call sites | Fields optional; defaults applied inside `post()`; §6 step 1 corrected |
| 8 | Major | Stale-`close` hazard: the FIFO queue holds a `close` while awaiting an LLM call → agent replies on a closed topic | Filter consults `channel.getHistory()` (the `close` is stored before emit at `channel.ts:21-22`), not a local cache; re-check before `post` |
| 9 | Major | Ownership/closed-set location ambiguous; the "no hidden global state" claim contradicts what routing needs | Shared coordination state lives in `Channel`; add `getHistory(topic?)` for per-topic windowing |
| 10 | Major | A summary injected as an `assistant` head turn is silently coerced to `user` (`agent.ts:71-74`), corrupting history | Inject summary via `system` (extend `llm.ts:10-19` signature) or as a `user` prelude |
| 11 | Major | Missing positive FR: satisfying all negative constraints could be met by total silence | FR11 added (Must): task lifecycle to completion — owner publishes summary + `close` |
| 12 | Major | FR6/FR7/FR8 are the load-bearing mechanisms for Must FR2–FR5, yet were rated Should | Elevated to Must (MoSCoW updated) |
| 13 | Major | Test harness must not import `main.tsx`/`app.tsx` (Ink/React render + `exit(1)` without a key) | Harness constructs `Channel` + `Agent` directly; `LLMClient` mocked structurally (`{ chat: async () => "…" }`); add `vitest.config.ts` `resolve.extensions` for `.js`-suffixed imports |
| 14 | Minor | README hint "cooldown or turn-taking" ignored without rationale | Accepted trade-off: per-task budgets + claim provide termination without a cooldown; a cooldown would only slow legitimate multi-agent turns. Revisit if loops persist. |
| 15 | Minor | `uuid` dep is unused (`channel.ts` uses `crypto.randomUUID`) | Optionally drop from `package.json` |
| 16 | Minor | Pre-render `join` color bug in `app.tsx` | Fix when wiring multi-agent config |

### 8.2 Revised design deltas (v2)

1. **`Channel` becomes the coordination kernel**, not just a bus: adds `claim(taskId)`, `close(taskId)`, `isClosed(taskId)`, `replyLedger(taskId, agentId)`, `getHistory(topic?)`. There is still **no central coordinator agent** — routing and turn decisions remain distributed; `Channel` only holds the shared facts.
2. **`Agent` filter** (`agent.ts:16-18`, before queue push): skip if `isClosed(topic)` || `to` is another agent || topic not in the role map || reply budget exhausted. Reads Channel state, never local caches.
3. **Reply budget** enforced at post time, keyed by `(taskId, agentId)`; `kind:"close"` and the owner's summary are exempt.
4. **Envelope** fields optional with `post()` defaults — keeps existing call sites compiling until the human-topic wiring step.
5. **Static role→topic map** extracted from `main.tsx` into a shared config (so tests reuse it): e.g. `{ engineer: [implementation], qa: [testing], pm: [planning, requirements] }`.
6. **Termination**: owner publishes a budget-exempt summary + broadcasts `close`; agents consult `Channel.isClosed`; `Channel` force-closes a topic after an inactivity timeout (stall watchdog).

### 8.3 Standing claims (confirmed correct)

- "Key insight" (root cause = broadcast + respond-to-everything) matches `README:50-52`.
- All §3 line references and the "358 lines TS" total verified accurate.
- "No new runtime dependencies" holds; `vitest` is dev-only.
