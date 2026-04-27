import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Bot, Gamepad2, MessageSquare, X, FileText, MessagesSquare } from "lucide-react";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  PixelOfficeRenderer,
  getWalkableBounds,
  getOptionalRoomBounds,
  PC_SEATS,
  REST_SEATS,
  FRAME_WIDTH,
  FRAME_HEIGHT,
  SPRITE_SCALE,
  RENDERED_W,
  RENDERED_H,
  type Seat,
  type SeatDirection,
} from "../components/PixelOfficeRenderer";
import { PixelChatPanel } from "../components/PixelChatPanel";
import { agentUrl, cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

const SHEET_COLS = 7;
const SHEET_ROWS = 3;

const SPEED = 50; // px per second
const FRAME_INTERVAL_MS = 160; // walk frame change interval
const MIN_IDLE_MS = 1500;
const MAX_IDLE_MS = 4500;
const VISIT_OTHER_ROOM_PROB = 0.18; // chance to walk into meeting/lounge while wandering
const SIT_ON_REST_PROB = 0.45; // chance an idle agent decides to sit instead of wander
const REST_SIT_MIN_MS = 6000;
const REST_SIT_MAX_MS = 16000;

// 10 distinct visual avatar variants: 6 base sprite sheets + 4 hue-rotated recolors.
interface AvatarDef {
  base: number;
  filter: string;
}
const AVATAR_DEFS: AvatarDef[] = [
  { base: 0, filter: "" },
  { base: 1, filter: "" },
  { base: 2, filter: "" },
  { base: 3, filter: "" },
  { base: 4, filter: "" },
  { base: 5, filter: "" },
  { base: 0, filter: "hue-rotate(140deg) saturate(1.2)" },
  { base: 1, filter: "hue-rotate(220deg) saturate(1.3)" },
  { base: 3, filter: "hue-rotate(80deg) saturate(1.5) brightness(0.95)" },
  { base: 4, filter: "hue-rotate(300deg) saturate(1.4)" },
];
const AVATAR_COUNT = AVATAR_DEFS.length;

function buildAvatarMap(allAgents: Agent[]): Map<string, number> {
  // Sort by id so assignments stay stable across renders, then assign avatars round-robin.
  // Within a company this gives every agent a unique avatar until the count exceeds AVATAR_COUNT.
  const sorted = [...allAgents]
    .filter((a) => a.status !== "terminated")
    .sort((a, b) => a.id.localeCompare(b.id));
  const map = new Map<string, number>();
  sorted.forEach((agent, idx) => {
    map.set(agent.id, idx % AVATAR_COUNT);
  });
  return map;
}

const SEATS_BY_ID: Map<string, Seat> = new Map(
  [...PC_SEATS, ...REST_SEATS].map((s) => [s.id, s]),
);

type Direction = SeatDirection;

interface AgentSim {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  direction: Direction;
  walking: boolean;
  walkFrame: number;
  nextFrameAt: number;
  resumeAt: number;
  avatarIdx: number;
  visualEl: HTMLElement | null;
  spriteEl: HTMLDivElement | null;
  agentStatus: "active" | "idle";
  seatId: string | null; // currently sitting in this seat
  intendedSeatId: string | null; // walking toward this seat
}

function statusLabel(agent: Agent): string {
  if (agent.status === "running") return "Working";
  if (agent.status === "active") return "Active";
  if (agent.status === "idle") return "Idle";
  if (agent.status === "paused") return agent.pauseReason === "budget" ? "Budget paused" : "On break";
  if (agent.status === "error") return "Error";
  if (agent.status === "pending_approval") return "Waiting";
  if (agent.status === "terminated") return "Terminated";
  return agent.status;
}

function isActiveStatus(status: string): boolean {
  return status === "running" || status === "active";
}

function isIdleStatus(status: string): boolean {
  return status === "idle" || status === "paused" || status === "pending_approval";
}

function pickRandomTarget(): { x: number; y: number } {
  const main = getWalkableBounds();
  const optional = getOptionalRoomBounds();
  const useOther = Math.random() < VISIT_OTHER_ROOM_PROB && optional.length > 0;
  const bounds = useOther ? optional[Math.floor(Math.random() * optional.length)] : main;
  return {
    x: bounds.minX + Math.random() * (bounds.maxX - bounds.minX - RENDERED_W),
    y: bounds.minY + Math.random() * (bounds.maxY - bounds.minY - RENDERED_H),
  };
}

function deterministicStart(idx: number, total: number): { x: number; y: number } {
  const b = getWalkableBounds();
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
  const cellW = (b.maxX - b.minX) / cols;
  const cellH = (b.maxY - b.minY) / Math.max(1, Math.ceil(total / cols));
  const c = idx % cols;
  const r = Math.floor(idx / cols);
  return {
    x: b.minX + cellW * c + cellW / 2 - RENDERED_W / 2,
    y: b.minY + cellH * r + cellH / 2 - RENDERED_H / 2,
  };
}

function pickDirection(dx: number, dy: number, prev: Direction): Direction {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return prev;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function spriteRow(direction: Direction): number {
  if (direction === "down") return 0;
  if (direction === "up") return 1;
  return 2;
}

function applyVisual(sim: AgentSim) {
  if (sim.visualEl) {
    sim.visualEl.style.transform = `translate(${sim.x}px, ${sim.y}px)`;
  }
  if (sim.spriteEl) {
    const row = spriteRow(sim.direction);
    const col = sim.walking ? sim.walkFrame % 4 : 0;
    sim.spriteEl.style.backgroundPosition = `-${col * FRAME_WIDTH * SPRITE_SCALE}px -${row * FRAME_HEIGHT * SPRITE_SCALE}px`;
    sim.spriteEl.style.transform = sim.direction === "left" ? "scaleX(-1)" : "scaleX(1)";
  }
}

function findFreeSeat(seats: Seat[], agentId: string, occupancy: Map<string, string>): Seat | null {
  // Random scan so agents spread across available seats.
  const order = Array.from({ length: seats.length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const i of order) {
    const s = seats[i];
    const holder = occupancy.get(s.id);
    if (!holder || holder === agentId) return s;
  }
  return null;
}

interface TalkModalState {
  agent: Agent;
}

type TalkMode = "chat" | "issue";

function AgentSpriteAvatar({ avatarIdx, size = 1.5 }: { avatarIdx: number; size?: number }) {
  const def = AVATAR_DEFS[avatarIdx % AVATAR_COUNT];
  return (
    <div
      style={{
        width: FRAME_WIDTH * size,
        height: FRAME_HEIGHT * size,
        backgroundImage: `url(/pixel-office/characters/char_${def.base}.png)`,
        backgroundPosition: "0 0",
        backgroundSize: `${FRAME_WIDTH * SHEET_COLS * size}px ${FRAME_HEIGHT * SHEET_ROWS * size}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
        filter: def.filter || undefined,
      }}
    />
  );
}

function TalkModal({
  state,
  avatarIdx,
  onClose,
  onTalk,
  onView,
}: {
  state: TalkModalState;
  avatarIdx: number;
  onClose: () => void;
  onTalk: (message: string) => void;
  onView: () => void;
}) {
  const [mode, setMode] = useState<TalkMode>("chat");
  const [issueMessage, setIssueMessage] = useState("");
  const issueInputRef = useRef<HTMLTextAreaElement>(null);
  const { agent } = state;

  useEffect(() => {
    if (mode === "issue") {
      issueInputRef.current?.focus();
    }
  }, [mode]);

  const handleIssueSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueMessage.trim()) return;
    onTalk(issueMessage.trim());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      data-testid="pixel-talk-overlay"
    >
      <div
        className="relative w-full max-w-md bg-card border-4 border-neutral-800 shadow-[6px_6px_0_rgb(0_0_0_/_0.5)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="pixel-talk-modal"
        style={{ imageRendering: "pixelated" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-neutral-900 text-white border-b-2 border-neutral-800">
          <div className="flex items-center gap-2">
            <AgentSpriteAvatar avatarIdx={avatarIdx} size={2} />
            <div>
              <div className="font-mono text-sm font-semibold">{agent.name}</div>
              <div className="text-[11px] text-neutral-400 font-mono">
                {roleLabels[agent.role] ?? agent.role}
                {agent.title ? ` · ${agent.title}` : ""}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b-2 border-neutral-800 bg-neutral-900/40">
          <ModeTab
            active={mode === "chat"}
            onClick={() => setMode("chat")}
            icon={<MessagesSquare className="h-3.5 w-3.5" />}
            label="잡담"
            sublabel="Chat"
            data-testid="pixel-talk-tab-chat"
          />
          <ModeTab
            active={mode === "issue"}
            onClick={() => setMode("issue")}
            icon={<FileText className="h-3.5 w-3.5" />}
            label="이슈"
            sublabel="Create issue"
            data-testid="pixel-talk-tab-issue"
          />
        </div>

        {/* Body */}
        {mode === "chat" ? (
          <PixelChatPanel
            agent={agent}
            agentAvatar={<AgentSpriteAvatar avatarIdx={avatarIdx} size={1} />}
          />
        ) : (
          <form onSubmit={handleIssueSubmit} className="p-4 space-y-3">
            <div className="text-xs text-muted-foreground font-mono">
              Status: <span className="text-foreground">{statusLabel(agent)}</span>
            </div>
            <textarea
              ref={issueInputRef}
              value={issueMessage}
              onChange={(e) => setIssueMessage(e.target.value)}
              placeholder={`${agent.name}에게 맡길 일을 입력하세요…`}
              rows={5}
              className="w-full px-3 py-2 text-sm bg-background border-2 border-neutral-800 font-mono resize-none focus:outline-none focus:border-foreground"
              data-testid="pixel-talk-input"
            />
            <p className="text-[11px] text-muted-foreground">
              제출 시 {agent.name}에게 할당된 이슈가 만들어지고, 댓글마다 follow-up run이 실행돼요.
            </p>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={onView}
                className="text-xs underline text-muted-foreground hover:text-foreground"
              >
                View profile
              </button>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!issueMessage.trim()}
                  data-testid="pixel-talk-send"
                >
                  <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                  이슈 생성
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
  sublabel,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sublabel: string;
} & React.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-mono transition-colors border-r-2 border-neutral-800 last:border-r-0",
        active
          ? "bg-foreground text-background"
          : "bg-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground"
      )}
      {...rest}
    >
      {icon}
      <span className="font-semibold">{label}</span>
      <span className="opacity-60 hidden sm:inline">/ {sublabel}</span>
    </button>
  );
}

type FilterTab = "all" | "active" | "idle";

export function PixelOffice() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialog();
  const navigate = useNavigate();
  const [tab, setTab] = useState<FilterTab>("all");
  const [talkAgent, setTalkAgent] = useState<Agent | null>(null);
  const [occupiedPcSeats, setOccupiedPcSeats] = useState<Set<string>>(new Set());
  const simsRef = useRef<Map<string, AgentSim>>(new Map());
  const seatOccupancyRef = useRef<Map<string, string>>(new Map()); // seatId -> agentId
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "pixel-office"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const liveAgentIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of liveRuns ?? []) {
      if (r.status === "running" || r.status === "queued") set.add(r.agentId);
    }
    return set;
  }, [liveRuns]);

  useEffect(() => {
    setBreadcrumbs([{ label: "The Office" }]);
  }, [setBreadcrumbs]);

  // Stable per-company avatar assignment — uses the full agent list (not just visible)
  // so that toggling filters does not reshuffle assigned avatars.
  const avatarMap = useMemo(() => buildAvatarMap(agents ?? []), [agents]);

  const visibleAgents = useMemo(() => {
    return (agents ?? [])
      .filter((a) => a.status !== "terminated")
      .filter((a) => {
        if (tab === "active") return isActiveStatus(a.status) || liveAgentIds.has(a.id);
        if (tab === "idle") return isIdleStatus(a.status);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, tab, liveAgentIds]);

  const counts = useMemo(() => {
    const all = (agents ?? []).filter((a) => a.status !== "terminated");
    const active = all.filter((a) => isActiveStatus(a.status) || liveAgentIds.has(a.id)).length;
    const idle = all.filter((a) => isIdleStatus(a.status)).length;
    return { total: all.length, active, idle };
  }, [agents, liveAgentIds]);

  // Initialize / sync agent simulation state when visible agents (or their statuses) change
  useEffect(() => {
    const sims = simsRef.current;
    const occupancy = seatOccupancyRef.current;
    const currentIds = new Set(visibleAgents.map((a) => a.id));

    // Drop sims for agents no longer visible — release any seats they hold.
    for (const id of Array.from(sims.keys())) {
      if (!currentIds.has(id)) {
        const sim = sims.get(id)!;
        if (sim.seatId && occupancy.get(sim.seatId) === id) occupancy.delete(sim.seatId);
        if (sim.intendedSeatId && occupancy.get(sim.intendedSeatId) === id) occupancy.delete(sim.intendedSeatId);
        sims.delete(id);
      }
    }

    // Add or update sims
    visibleAgents.forEach((agent, idx) => {
      const newStatus: "active" | "idle" =
        isActiveStatus(agent.status) || liveAgentIds.has(agent.id) ? "active" : "idle";
      const avatarIdx = avatarMap.get(agent.id) ?? 0;
      const existing = sims.get(agent.id);
      if (!existing) {
        const start = deterministicStart(idx, visibleAgents.length);
        sims.set(agent.id, {
          x: start.x,
          y: start.y,
          targetX: start.x,
          targetY: start.y,
          direction: "down",
          walking: false,
          walkFrame: 0,
          nextFrameAt: 0,
          resumeAt: performance.now() + Math.random() * 1500,
          avatarIdx,
          visualEl: null,
          spriteEl: null,
          agentStatus: newStatus,
          seatId: null,
          intendedSeatId: null,
        });
      } else {
        existing.avatarIdx = avatarIdx;
        if (existing.agentStatus !== newStatus) {
          existing.agentStatus = newStatus;
          // Force re-evaluation of next action: release any held/intended seat.
          if (existing.seatId && occupancy.get(existing.seatId) === agent.id) {
            occupancy.delete(existing.seatId);
          }
          existing.seatId = null;
          if (existing.intendedSeatId && occupancy.get(existing.intendedSeatId) === agent.id) {
            occupancy.delete(existing.intendedSeatId);
          }
          existing.intendedSeatId = null;
          existing.walking = false;
          existing.walkFrame = 0;
          existing.resumeAt = performance.now() + 100 + Math.random() * 400;
        }
      }
    });
  }, [visibleAgents, liveAgentIds, avatarMap]);

  // Animation loop
  useEffect(() => {
    const tick = (now: number) => {
      const dt = lastTickRef.current ? (now - lastTickRef.current) / 1000 : 0;
      lastTickRef.current = now;

      const occupancy = seatOccupancyRef.current;

      for (const [agentId, sim] of simsRef.current) {
        if (!sim.walking) {
          if (now >= sim.resumeAt) {
            // If currently sitting, release seat before deciding next action.
            if (sim.seatId) {
              if (occupancy.get(sim.seatId) === agentId) occupancy.delete(sim.seatId);
              sim.seatId = null;
            }

            let chosen: Seat | null = null;
            if (sim.agentStatus === "active") {
              chosen = findFreeSeat(PC_SEATS, agentId, occupancy);
            } else if (Math.random() < SIT_ON_REST_PROB) {
              chosen = findFreeSeat(REST_SEATS, agentId, occupancy);
            }

            if (chosen) {
              occupancy.set(chosen.id, agentId);
              sim.intendedSeatId = chosen.id;
              sim.targetX = chosen.spriteX;
              sim.targetY = chosen.spriteY;
            } else {
              // Wander
              sim.intendedSeatId = null;
              const target = pickRandomTarget();
              sim.targetX = target.x;
              sim.targetY = target.y;
            }
            sim.walking = true;
            sim.nextFrameAt = now + FRAME_INTERVAL_MS;
          }
        } else {
          const dx = sim.targetX - sim.x;
          const dy = sim.targetY - sim.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 1.5) {
            sim.x = sim.targetX;
            sim.y = sim.targetY;
            sim.walking = false;
            sim.walkFrame = 0;
            if (sim.intendedSeatId) {
              const seat = SEATS_BY_ID.get(sim.intendedSeatId);
              sim.seatId = sim.intendedSeatId;
              sim.intendedSeatId = null;
              if (seat) sim.direction = seat.direction;
              // Active agents at PC stay until their status changes; idle agents on
              // sofa/chair stay for a random window then choose again.
              if (sim.agentStatus === "active") {
                sim.resumeAt = Number.MAX_SAFE_INTEGER;
              } else {
                sim.resumeAt = now + REST_SIT_MIN_MS + Math.random() * (REST_SIT_MAX_MS - REST_SIT_MIN_MS);
              }
            } else {
              sim.resumeAt = now + MIN_IDLE_MS + Math.random() * (MAX_IDLE_MS - MIN_IDLE_MS);
            }
          } else {
            const step = SPEED * dt;
            const nx = (dx / dist) * Math.min(step, dist);
            const ny = (dy / dist) * Math.min(step, dist);
            sim.x += nx;
            sim.y += ny;
            sim.direction = pickDirection(dx, dy, sim.direction);
            if (now >= sim.nextFrameAt) {
              sim.walkFrame = (sim.walkFrame + 1) % 4;
              sim.nextFrameAt = now + FRAME_INTERVAL_MS;
            }
          }
        }
        applyVisual(sim);
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTickRef.current = 0;
    };
  }, []);

  // Poll seat occupancy ref for PC seats so the renderer can flip PCs to ON.
  // Polling avoids re-rendering on every animation frame.
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = new Set<string>();
      for (const seatId of seatOccupancyRef.current.keys()) {
        if (seatId.startsWith("pc-seat-")) next.add(seatId);
      }
      setOccupiedPcSeats((prev) => {
        if (prev.size === next.size) {
          let same = true;
          for (const v of prev) {
            if (!next.has(v)) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next;
      });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const handleTalk = (message: string) => {
    if (!talkAgent) return;
    const truncated = message.length > 80 ? `${message.slice(0, 77)}...` : message;
    openNewIssue({
      assigneeAgentId: talkAgent.id,
      title: truncated,
      description: message,
    });
    setTalkAgent(null);
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view the office." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <style>{`
        .pixel-character {
          width: ${RENDERED_W}px;
          height: ${RENDERED_H}px;
          background-repeat: no-repeat;
          background-size: ${FRAME_WIDTH * SHEET_COLS * SPRITE_SCALE}px ${FRAME_HEIGHT * SHEET_ROWS * SPRITE_SCALE}px;
          image-rendering: pixelated;
          transform-origin: center;
        }
      `}</style>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Gamepad2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">The Office</h1>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <FilterChip
            active={tab === "active"}
            onClick={() => setTab(tab === "active" ? "all" : "active")}
            color="green"
            label={`${counts.active} active`}
            data-testid="pixel-filter-active"
          />
          <FilterChip
            active={tab === "idle"}
            onClick={() => setTab(tab === "idle" ? "all" : "idle")}
            color="gray"
            label={`${counts.idle} idle`}
            data-testid="pixel-filter-idle"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState icon={Bot} message="No agents to display in the office yet." />
      )}

      {visibleAgents.length > 0 && (
        <PixelOfficeRenderer occupiedPcSeatIds={occupiedPcSeats}>
          {visibleAgents.map((agent) => {
            const isLive = liveAgentIds.has(agent.id);
            const avatarIdx = avatarMap.get(agent.id) ?? 0;
            const def = AVATAR_DEFS[avatarIdx % AVATAR_COUNT];
            const status = statusLabel(agent);
            const spriteFilter = [
              def.filter,
              isLive
                ? "drop-shadow(0 0 5px rgb(34 211 238 / 0.85))"
                : agent.status === "error"
                  ? "drop-shadow(0 0 5px rgb(248 113 113 / 0.7))"
                  : "drop-shadow(0 1px 0 rgb(0 0 0 / 0.6))",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={agent.id}
                type="button"
                data-testid={`pixel-agent-${agent.id}`}
                data-agent-name={agent.name}
                onClick={() => setTalkAgent(agent)}
                ref={(el) => {
                  const sim = simsRef.current.get(agent.id);
                  if (sim) sim.visualEl = el;
                  if (sim && el) {
                    el.style.transform = `translate(${sim.x}px, ${sim.y}px)`;
                  }
                }}
                className="absolute top-0 left-0 group bg-transparent border-0 p-0 cursor-pointer focus:outline-none z-10"
                style={{ willChange: "transform" }}
              >
                <div className="relative flex flex-col items-center gap-0.5" style={{ width: RENDERED_W }}>
                  <div className="flex flex-col items-center gap-0.5 -mb-1 pointer-events-none">
                    <div className="px-1 py-px text-[9px] font-mono bg-black/85 text-white whitespace-nowrap leading-tight">
                      {status}
                    </div>
                    <div className="px-1 py-px text-[9px] font-mono font-semibold bg-foreground text-background whitespace-nowrap leading-tight">
                      {agent.name}
                    </div>
                  </div>
                  <div
                    className="pixel-character"
                    style={{
                      backgroundImage: `url(/pixel-office/characters/char_${def.base}.png)`,
                      filter: spriteFilter,
                    }}
                    ref={(el) => {
                      const sim = simsRef.current.get(agent.id);
                      if (sim) sim.spriteEl = el;
                    }}
                  />
                  {isLive && (
                    <span className="absolute -top-1 -right-1 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </PixelOfficeRenderer>
      )}

      <p className="text-xs text-muted-foreground text-center">
        Click a character to talk · Inspired by{" "}
        <a
          href="https://github.com/pablodelucca/coderon-pixel-agents"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-foreground"
        >
          Pixel Agents
        </a>
      </p>

      {talkAgent && (
        <TalkModal
          state={{ agent: talkAgent }}
          avatarIdx={avatarMap.get(talkAgent.id) ?? 0}
          onClose={() => setTalkAgent(null)}
          onTalk={handleTalk}
          onView={() => {
            const a = talkAgent;
            setTalkAgent(null);
            navigate(agentUrl(a));
          }}
        />
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  color,
  label,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  color: "green" | "gray";
  label: string;
} & React.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 border transition-colors font-mono",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:bg-accent/50"
      )}
      {...rest}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          color === "green" ? "bg-green-500" : "bg-neutral-500"
        )}
      />
      {label}
    </button>
  );
}
