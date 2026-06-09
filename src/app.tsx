import React, { useState, useEffect } from "react";
import { Box, Text, Static } from "ink";
import TextInput from "ink-text-input";
import type { Channel } from "./channel.js";
import type { Message } from "./types.js";

const AGENT_COLORS = [
  "cyan",
  "magenta",
  "yellow",
  "green",
  "blue",
  "red",
] as const;

type Color = (typeof AGENT_COLORS)[number];

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function MessageLine({
  msg,
  channel,
  colorMap,
}: {
  msg: Message;
  channel: Channel;
  colorMap: Map<string, Color>;
}) {
  const time = formatTime(msg.timestamp);
  const isHuman = msg.from === "human";
  const displayName = isHuman ? "you" : channel.getDisplayName(msg.from);
  const color = isHuman ? "white" : colorMap.get(msg.from) ?? "cyan";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text dimColor>{time} </Text>
        <Text color={color} bold={isHuman}>
          {displayName}
        </Text>
        <Text>: {msg.content}</Text>
      </Text>
    </Box>
  );
}

function JoinLine({ name, color }: { name: string; color: Color }) {
  return (
    <Text dimColor>
      {"  "}
      <Text color={color}>{name}</Text> joined the channel
    </Text>
  );
}

type LogEntry =
  | { type: "header"; channelName: string }
  | { type: "message"; msg: Message }
  | { type: "join"; name: string; color: Color };

export function App({ channel }: { channel: Channel }) {
  const [log, setLog] = useState<LogEntry[]>([
    { type: "header", channelName: channel.getName() },
  ]);
  const [input, setInput] = useState("");
  const [colorMap] = useState(() => new Map<string, Color>());
  const [colorIndex, setColorIndex] = useState(0);

  function assignColor(agentId: string): Color {
    if (!colorMap.has(agentId)) {
      const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length];
      colorMap.set(agentId, color);
      setColorIndex((i) => i + 1);
      return color;
    }
    return colorMap.get(agentId)!;
  }

  useEffect(() => {
    const onMessage = (msg: Message) => {
      setLog((prev) => [...prev, { type: "message", msg }]);
    };
    const onJoin = ({ agentId, displayName }: { agentId: string; displayName: string }) => {
      const color = assignColor(agentId);
      setLog((prev) => [...prev, { type: "join", name: displayName, color }]);
    };

    channel.on("message", onMessage);
    channel.on("join", onJoin);
    return () => {
      channel.off("message", onMessage);
      channel.off("join", onJoin);
    };
  }, [channel]);

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      channel.post("human", trimmed);
    }
    setInput("");
  };

  return (
    <Box flexDirection="column">
      <Static items={log}>
        {(entry, i) => {
          if (entry.type === "header") {
            return (
              <Box key="header" flexDirection="column" marginBottom={1}>
                <Text bold> {entry.channelName}</Text>
                <Text dimColor> ─────────────────────────────────</Text>
              </Box>
            );
          }
          if (entry.type === "join") {
            return <JoinLine key={`join-${i}`} name={entry.name} color={entry.color} />;
          }
          return (
            <MessageLine
              key={entry.msg.id}
              msg={entry.msg}
              channel={channel}
              colorMap={colorMap}
            />
          );
        }}
      </Static>

      <Box>
        <Text dimColor>{">"} </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
