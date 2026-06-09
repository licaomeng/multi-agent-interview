export interface Message {
  id: string;
  timestamp: number;
  from: string;
  content: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
}
