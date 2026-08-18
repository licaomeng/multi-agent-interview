export type MessageKind =
  | "question"
  | "answer"
  | "review"
  | "announce"
  | "close";

export interface Message {
  id: string;
  timestamp: number;
  from: string;
  content: string;
  // v2 envelope (all optional, defaults applied inside channel.post):
  to?: string | "channel";
  topic?: string;
  kind?: MessageKind;
  // Fixed task identity minted once by the Channel. Keyed for budgets and
  // ownership so that re-topic / rename cannot dodge coordination state.
  taskId?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  // Static role -> topic map. Routing decisions come from this config,
  // never from LLM-authored content.
  topics: string[];
}
