// Per-CLI differences: which files HQ writes into the agent's folder and how
// the agent is launched. Everything else (hooks → state, Team MCP, delivery)
// is shared — Codex and Claude Code send the same hook payloads.

import { agentRead, agentWrite } from "./lib/agentFs";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";
import { adoptRoleFile, excludeFromGit, HOOK_SCRIPT, ROLE_FILE, type RoleExtras, hookCommand, hookScriptFor, hqUrl, MCP_CONFIG, roleMd, writeClaudeFiles, writeHookScript } from "./agentFiles";
import { run } from "./lib/exec";

export interface Launch {
  sbxAgent: string; // agent name for `sbx run`
  args: string[]; // the CLI's own arguments (not shell-quoted)
}

export interface CliAdapter {
  /** Writes HQ's files into the agent's folder (all git-excluded). */
  writeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras?: RoleExtras): Promise<void>;
  launch(agent: AgentConfig): Launch;
}

// ---------------------------------------------------------------- Claude Code

const claude: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent) {
    // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
    const m = agent.model.trim();
    const model = !m || /^default$/i.test(m) ? null : /^(opus|sonnet|haiku)$/i.test(m) ? m.toLowerCase() : m;
    // Relative to the agent's folder, where it starts. An absolute path would be the host's, and on
    // Windows the folder has a different path inside the sandbox (C:\x on the host, /c/x in the sandbox).
    return { sbxAgent: "claude", args: ["--mcp-config", MCP_CONFIG, ...(model ? ["--model", model] : [])] };
  },
};

// ---------------------------------------------------------------- Codex

export const CODEX_CONFIG = ".codex/config.toml";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/** TOML basic string (JSON's escaping is valid TOML for these characters). */
const t = (s: string) => JSON.stringify(s);

export function codexConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, extras: RoleExtras = {}): string {
  const url = hqUrl(agent, cfg.project.hqPort);
  const script = hookScriptFor(agent, dir);
  const lines = [
    "# Written by JSM HQ for this agent (git-excluded). Codex loads it once you trust this folder.",
    `developer_instructions = ${t(roleMd(agent, cfg, extras))}`,
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.hq]",
    `url = ${t(`${url}/mcp`)}`,
    `http_headers = { Authorization = ${t(`Bearer ${token}`)}, "X-HQ-Agent" = ${t(agent.id)} }`,
  ];
  for (const event of CODEX_EVENTS)
    lines.push("", `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(hookCommand(url, token, agent.id, event, script))}`);
  return lines.join("\n") + "\n";
}

const codex: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    // A repo that commits its own Codex config can't take HQ's without changing a tracked file.
    const tracked = await run("git", ["ls-files", "--error-unmatch", CODEX_CONFIG], { cwd: dir });
    if (tracked.ok) throw new Error(`This repo commits ${CODEX_CONFIG}, so HQ can't add its Codex settings without changing a tracked file. Use Claude Code for this agent, or remove that file from the repo.`);
    // The role goes in the config (developer_instructions); the folder's own ROLE.md is included, never overwritten.
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, CODEX_CONFIG, codexConfig(agent, cfg, token, dir, { ...extras, ownRole }), { mode: 0o600 });
    if (hookScriptFor(agent, dir)) writeHookScript(dir);
    excludeFromGit(dir, [CODEX_CONFIG, HOOK_SCRIPT]);
  },
  launch(agent) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    return { sbxAgent: "codex", args: model ? ["-m", model] : [] };
  },
};

// ---------------------------------------------------------------- Cursor

const CURSOR_HOOKS = ".cursor/hooks.json";
const CURSOR_MCP = ".cursor/mcp.json";
const CURSOR_CLI = ".cursor/cli.json";
/** Cursor event name → the HQ event the shared hook handler already understands. */
const CURSOR_EVENTS: [string, string][] = [
  ["sessionStart", "SessionStart"],
  ["beforeSubmitPrompt", "UserPromptSubmit"],
  ["preToolUse", "PreToolUse"],
  ["postToolUse", "PostToolUse"],
  ["stop", "Stop"],
  ["sessionEnd", "SessionEnd"],
];

type CursorHook = { command: string; timeout?: number; loop_limit?: number | null; matcher?: string };
type CursorHooksFile = { version?: number; hooks?: Record<string, CursorHook[]> };

function trackedFile(dir: string, rel: string): Promise<boolean> {
  return run("git", ["ls-files", "--error-unmatch", rel], { cwd: dir }).then((r) => r.ok);
}

function readJson(dir: string, rel: string): Record<string, unknown> {
  const raw = agentRead(dir, rel);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Cursor CLI files: role (via the sessionStart hook), hooks, Team MCP, and permission to call it. */
async function writeCursorFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras) {
  for (const rel of [CURSOR_HOOKS, CURSOR_MCP]) {
    if (await trackedFile(dir, rel)) {
      throw new Error(`This repo commits ${rel}, so HQ can't add its Cursor settings without changing a tracked file. Use Claude Code or Codex for this agent, or remove that file from the repo.`);
    }
  }
  const ownRole = await adoptRoleFile(dir);
  agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, { ...extras, ownRole }));
  writeHookScript(dir);

  const url = hqUrl(agent, cfg.project.hqPort);
  const existing = readJson(dir, CURSOR_HOOKS) as CursorHooksFile;
  const hooks: Record<string, CursorHook[]> = { ...(existing.hooks ?? {}) };
  for (const [cursorEvent, hqEvent] of CURSOR_EVENTS) {
    const current = Array.isArray(hooks[cursorEvent]) ? hooks[cursorEvent] : [];
    const kept = current.filter((h) => !h.command?.includes("--jsmhq-hook") && !h.command?.includes("# jsmhq-hook"));
    const ours: CursorHook = { command: hookCommand(url, token, agent.id, hqEvent, null, true), timeout: hqEvent === "Stop" ? 10 : 5 };
    if (cursorEvent === "stop") ours.loop_limit = null; // HQ may hand over more than Cursor's default of 5 queued messages
    hooks[cursorEvent] = [...kept, ours];
  }
  agentWrite(dir, CURSOR_HOOKS, JSON.stringify({ ...existing, version: 1, hooks }, null, 2) + "\n");

  const mcp = readJson(dir, CURSOR_MCP);
  const servers = mcp.mcpServers && typeof mcp.mcpServers === "object" && !Array.isArray(mcp.mcpServers) ? (mcp.mcpServers as Record<string, unknown>) : {};
  servers.hq = {
    url: `${url}/mcp`,
    headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id },
  };
  agentWrite(dir, CURSOR_MCP, JSON.stringify({ ...mcp, mcpServers: servers }, null, 2) + "\n", { mode: 0o600 });

  // Let the team server run without an approval prompt on every call. A committed cli.json is left alone.
  if (!(await trackedFile(dir, CURSOR_CLI))) {
    const cli = readJson(dir, CURSOR_CLI);
    const permissions = cli.permissions && typeof cli.permissions === "object" && !Array.isArray(cli.permissions) ? (cli.permissions as Record<string, unknown>) : {};
    const allow = new Set([...(Array.isArray(permissions.allow) ? permissions.allow.filter((x): x is string => typeof x === "string") : []), "Mcp(hq:*)"]);
    agentWrite(dir, CURSOR_CLI, JSON.stringify({ ...cli, permissions: { ...permissions, allow: [...allow] } }, null, 2) + "\n");
  }

  excludeFromGit(dir, [ROLE_FILE, HOOK_SCRIPT, CURSOR_HOOKS, CURSOR_MCP, CURSOR_CLI]);
}

const cursor: CliAdapter = {
  writeFiles: writeCursorFiles,
  launch(agent) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    // --approve-mcps lets the Team MCP connect. Sandboxes also start cursor-agent with --yolo.
    return { sbxAgent: "cursor", args: ["--approve-mcps", ...(model ? ["--model", model] : [])] };
  },
};

export const adapters: Record<AgentCli, CliAdapter> = { claude, codex, cursor };

/** The command a Local-mode agent runs on the host. */
export const localBinary: Record<AgentCli, string> = { claude: "claude", codex: "codex", cursor: "agent" };
