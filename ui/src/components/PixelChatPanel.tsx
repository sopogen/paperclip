import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import type { Agent } from "@paperclipai/shared";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  ts: number;
  isError?: boolean;
}

interface PixelChatPanelProps {
  agent: Agent;
  /** Image rendered next to agent's bubbles (sprite) */
  agentAvatar: React.ReactNode;
}

export function PixelChatPanel({ agent, agentAvatar }: PixelChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [agentTyping, setAgentTyping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Welcome message + reset on agent change
  useEffect(() => {
    const greet: ChatMessage = {
      id: `g-${Date.now()}`,
      role: "agent",
      text: `안녕하세요! 저는 ${agent.name}이에요. 무엇이든 편하게 물어보세요. (직위, 보스, 팀원, 지금 하는 일 등)`,
      ts: Date.now(),
    };
    setMessages([greet]);
    setInput("");
    setAgentTyping(false);
    return () => {
      abortRef.current?.abort();
    };
  }, [agent.id, agent.name]);

  // Autoscroll
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, agentTyping]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [agent.id]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || agentTyping) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text,
      ts: Date.now(),
    };
    const baseMessages = [...messages, userMsg];
    setMessages(baseMessages);
    setInput("");
    setAgentTyping(true);

    // Build conversation history: skip the welcome message; convert "agent" → "assistant"
    const history = baseMessages
      .filter((m) => !m.isError)
      .slice(1) // drop welcome bubble
      .map<{ role: "user" | "assistant"; content: string }>((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }));

    try {
      const reply = await agentsApi.casualChat(agent.id, history);
      const replyMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: "agent",
        text: reply.content,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, replyMsg]);
    } catch (err) {
      const errMsg = err instanceof ApiError ? err.message : (err as Error).message;
      const failMsg: ChatMessage = {
        id: `e-${Date.now()}`,
        role: "agent",
        text: `❌ 응답 실패: ${errMsg}`,
        ts: Date.now(),
        isError: true,
      };
      setMessages((prev) => [...prev, failMsg]);
    } finally {
      setAgentTyping(false);
      // Restore focus after the reply lands
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <div className="flex flex-col h-[420px]" data-testid="pixel-chat-panel">
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2 bg-background/50"
      >
        {messages.map((msg) => (
          <ChatBubble key={msg.id} msg={msg} agentAvatar={agentAvatar} />
        ))}
        {agentTyping && <TypingBubble agentAvatar={agentAvatar} />}
      </div>

      <form
        onSubmit={handleSend}
        className="flex items-center gap-2 px-3 py-2 border-t-2 border-neutral-800 bg-background"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={agentTyping ? `${agent.name}이 답하는 중…` : `${agent.name}에게 잡담을 걸어보세요…`}
          disabled={agentTyping}
          className="flex-1 px-3 py-2 text-sm bg-background border-2 border-neutral-800 font-mono focus:outline-none focus:border-foreground disabled:opacity-60"
          data-testid="pixel-chat-input"
        />
        <button
          type="submit"
          disabled={!input.trim() || agentTyping}
          className="px-3 py-2 border-2 border-foreground bg-foreground text-background hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="pixel-chat-send"
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}

function ChatBubble({ msg, agentAvatar }: { msg: ChatMessage; agentAvatar: React.ReactNode }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      {!isUser && <div className="shrink-0">{agentAvatar}</div>}
      <div
        className={`max-w-[78%] px-3 py-2 text-sm font-mono whitespace-pre-line border-2 ${
          isUser
            ? "bg-foreground text-background border-foreground"
            : msg.isError
              ? "bg-destructive/10 text-destructive border-destructive"
              : "bg-card text-foreground border-neutral-800"
        }`}
        style={{ imageRendering: "pixelated" }}
      >
        {msg.text}
      </div>
    </div>
  );
}

function TypingBubble({ agentAvatar }: { agentAvatar: React.ReactNode }) {
  return (
    <div className="flex items-end gap-2">
      <div className="shrink-0">{agentAvatar}</div>
      <div
        className="px-3 py-2 bg-card text-foreground border-2 border-neutral-800"
        style={{ imageRendering: "pixelated" }}
        data-testid="pixel-chat-typing"
      >
        <span className="inline-flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="h-1.5 w-1.5 rounded-full bg-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="h-1.5 w-1.5 rounded-full bg-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
        </span>
      </div>
    </div>
  );
}
