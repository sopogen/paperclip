import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { agentService, issueService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound, unprocessable } from "../errors.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface OrgNodeShape {
  id: string;
  name: string;
  role: string;
  title?: string | null;
  reports: OrgNodeShape[];
}

function findInTree(
  nodes: OrgNodeShape[],
  agentId: string,
  parent: OrgNodeShape | null = null,
): { node: OrgNodeShape; parent: OrgNodeShape | null } | null {
  for (const node of nodes) {
    if (node.id === agentId) return { node, parent };
    const found = findInTree(node.reports, agentId, node);
    if (found) return found;
  }
  return null;
}

function roleLabel(role: string): string {
  return (AGENT_ROLE_LABELS as Record<string, string>)[role] ?? role;
}

function nameWithRole(name: string, role: string): string {
  const label = roleLabel(role);
  if (name.toLowerCase() === label.toLowerCase()) return name;
  return `${name} (${label})`;
}

interface AgentRecord {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  pauseReason: string | null;
  adapterType: string;
  companyId: string;
}

interface BuildPromptInput {
  agent: AgentRecord;
  boss: { id: string; name: string; role: string } | null;
  reports: { id: string; name: string; role: string }[];
  liveRunCount: number;
  openIssues: { identifier: string | null; title: string; status: string }[];
}

function buildSystemPrompt(input: BuildPromptInput): string {
  const { agent, boss, reports, liveRunCount, openIssues } = input;
  const lines: string[] = [];

  const titleSuffix = agent.title && agent.title.toLowerCase() !== roleLabel(agent.role).toLowerCase()
    ? ` (also titled "${agent.title}")`
    : "";

  lines.push(
    `You are ${agent.name}, a ${roleLabel(agent.role)}${titleSuffix} working at the company. You are an AI agent inside the Paperclip platform.`,
  );
  lines.push("");
  lines.push("Persona & guidelines:");
  lines.push("- Stay in character as this person on the team.");
  lines.push("- Reply in the user's language (Korean or English) — match what they wrote.");
  lines.push("- Be concise and natural, like a quick chat with a coworker. 1–4 sentences.");
  lines.push("- For questions about your boss, reports, role, or current work, use the facts below.");
  lines.push("- Don't invent issues, teammates, or projects that aren't listed.");
  lines.push("- If asked something outside your knowledge, say so plainly and offer to take it on as a task.");
  lines.push("");
  lines.push("=== Your facts ===");
  lines.push(`Name: ${agent.name}`);
  lines.push(`Role: ${roleLabel(agent.role)}`);
  if (agent.title) lines.push(`Title: ${agent.title}`);
  lines.push(`Adapter: ${agent.adapterType}`);
  lines.push(`Status: ${agent.status}${agent.pauseReason ? ` (pauseReason=${agent.pauseReason})` : ""}`);
  lines.push("");

  if (boss) {
    lines.push(`Manager (your boss): ${nameWithRole(boss.name, boss.role)}`);
  } else {
    lines.push(`Manager: none — you are at the top of the org.`);
  }
  lines.push("");

  if (reports.length === 0) {
    lines.push(`Direct reports: none — you don't manage anyone.`);
  } else {
    lines.push(`Direct reports (${reports.length}):`);
    for (const r of reports) {
      lines.push(`- ${nameWithRole(r.name, r.role)}`);
    }
  }
  lines.push("");

  lines.push(`Active runs right now: ${liveRunCount}`);
  if (openIssues.length === 0) {
    lines.push(`Open assigned issues: none — you are currently free.`);
  } else {
    lines.push(`Open assigned issues (${openIssues.length}):`);
    for (const i of openIssues.slice(0, 25)) {
      const id = i.identifier ? `[${i.identifier}] ` : "";
      lines.push(`- ${id}${i.title} (status: ${i.status})`);
    }
  }

  return lines.join("\n");
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-5.4";
const MAX_HISTORY_MESSAGES = 30;

export function agentCasualChatRoutes(db: Db) {
  const router = Router();
  const agentSvc = agentService(db);
  const issueSvc = issueService(db);

  router.post("/agents/:id/casual-chat", async (req: Request, res) => {
    const id = req.params.id as string;
    const agent = await agentSvc.getById(id);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: "Casual chat is unavailable: OPENROUTER_API_KEY is not configured on the server.",
      });
      return;
    }

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      throw unprocessable("messages must be a non-empty array");
    }
    const messages: ChatMessage[] = [];
    for (const m of rawMessages.slice(-MAX_HISTORY_MESSAGES)) {
      if (!m || typeof m !== "object") continue;
      const role = (m as { role?: unknown }).role;
      const content = (m as { content?: unknown }).content;
      if (role !== "user" && role !== "assistant") continue;
      if (typeof content !== "string" || !content.trim()) continue;
      messages.push({ role, content: content.trim().slice(0, 4000) });
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      throw unprocessable("messages must end with a user message");
    }

    // Build context
    const orgTree = (await agentSvc.orgForCompany(agent.companyId)) as unknown as OrgNodeShape[];
    const found = findInTree(orgTree, agent.id);
    const boss = found?.parent
      ? { id: found.parent.id, name: found.parent.name, role: found.parent.role }
      : null;
    const reports = found
      ? found.node.reports.map((r) => ({ id: r.id, name: r.name, role: r.role }))
      : [];

    // Open issues for this agent (limit 25)
    const issueRows = await issueSvc.list(agent.companyId, {
      assigneeAgentId: agent.id,
      limit: 25,
    });
    const openIssues = (issueRows ?? [])
      .filter((row) => row.status !== "done" && row.status !== "cancelled")
      .map((row) => ({
        identifier: row.identifier ?? null,
        title: row.title,
        status: row.status,
      }));

    // Live runs for this agent
    const runRows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
          sql`${heartbeatRuns.status} IN ('running','queued')`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(10);
    const liveRunCount = runRows.length;

    const systemPrompt = buildSystemPrompt({
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title ?? null,
        status: agent.status,
        pauseReason: (agent as { pauseReason?: string | null }).pauseReason ?? null,
        adapterType: agent.adapterType,
        companyId: agent.companyId,
      },
      boss,
      reports,
      liveRunCount,
      openIssues,
    });

    const model = (typeof req.body?.model === "string" && req.body.model) || DEFAULT_MODEL;

    let upstream: Response;
    try {
      upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost",
          "X-Title": "Paperclip Pixel Office Chat",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          temperature: 0.7,
          max_tokens: 600,
        }),
      });
    } catch (err) {
      res.status(502).json({
        error: `Failed to reach OpenRouter: ${(err as Error).message}`,
      });
      return;
    }

    const upstreamText = await upstream.text();
    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: `OpenRouter ${upstream.status}: ${upstreamText.slice(0, 800)}`,
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      res.status(502).json({ error: "OpenRouter returned non-JSON response" });
      return;
    }

    const content =
      ((parsed as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "").trim();

    if (!content) {
      res.status(502).json({ error: "OpenRouter returned an empty response" });
      return;
    }

    res.json({
      content,
      model,
    });
  });

  return router;
}
