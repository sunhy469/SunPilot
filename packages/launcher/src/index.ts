#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import open from "open";
import {
  getSunPilotPaths,
  readSunPilotConfig,
  type SunPilotConfig,
  type SunPilotPaths,
} from "@sunpilot/storage";
import { DEFAULT_WEB_URL } from "@sunpilot/protocol";

// P1-12: Verify that the PID in the PID file still belongs to a SunPilot
// daemon before sending SIGTERM. A reused PID must never cause the launcher
// to kill an unrelated process.
//
// The daemon writes both a command identity and Linux process start ticks.
// A PID is signalled only when both still match; legacy/unverifiable files are
// treated as stale. This prevents PID reuse from terminating another process.

/** Tokens that identify a SunPilot daemon process in /proc/<pid>/cmdline. */
const DAEMON_CMDLINE_MARKERS = ["@sunpilot/daemon", "packages/daemon/dist/main.js"];

interface PidFileEntry {
  pid: number;
  startedAt?: string;
  processStartTicks?: string;
}

/**
 * Parse the PID file. Supports both the new JSON format
 * ({pid, startedAt, processStartTicks}) and the legacy plain-number format.
 */
function parsePidFile(raw: string): PidFileEntry | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try JSON first (new format).
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<PidFileEntry>;
      if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0) {
        return {
          pid: parsed.pid,
          startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
          processStartTicks:
            typeof parsed.processStartTicks === "string"
              ? parsed.processStartTicks
              : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  // Legacy: plain number.
  const pid = Number(trimmed);
  if (Number.isFinite(pid) && pid > 0) return { pid };
  return null;
}

/**
 * Read /proc/<pid>/cmdline (Linux) and verify the process command line
 * contains a SunPilot daemon marker. Returns false when the file cannot
 * be read or the process is not a SunPilot daemon.
 */
function isDaemonProcess(entry: PidFileEntry): boolean {
  // Without a stable process birth identity it is not safe to signal a PID.
  if (process.platform !== "linux" || !entry.processStartTicks) return false;
  try {
    const cmdline = readFileSync(`/proc/${entry.pid}/cmdline`, "utf8");
    if (!DAEMON_CMDLINE_MARKERS.some((marker) => cmdline.includes(marker))) {
      return false;
    }
    const stat = readFileSync(`/proc/${entry.pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return false;
    const actualStartTicks = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
    return actualStartTicks === entry.processStartTicks;
  } catch {
    // File missing or unreadable — process likely doesn't exist.
    return false;
  }
}

type SpawnLike = typeof spawn;
const require = createRequire(import.meta.url);

// Ar16: Restart polling tunables — previously inline magic numbers.
const RESTART_POLL_DEADLINE_MS = 10_000;
const RESTART_POLL_INTERVAL_MS = 200;

interface LauncherArgs {
  command: string;
  foreground: boolean;
  port?: number;
  lines?: number;
}

function parseArgs(argv: string[]): LauncherArgs {
  const args = argv.filter((arg) => arg !== "--");
  const command = args[0] ?? "help";
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
  const linesIndex = args.indexOf("--lines");
  const parsedLines = linesIndex >= 0 ? Number(args[linesIndex + 1]) : NaN;
  return {
    command,
    foreground: args.includes("--foreground"),
    port: Number.isFinite(port) ? port : undefined,
    lines:
      Number.isFinite(parsedLines) && parsedLines > 0
        ? Math.floor(parsedLines)
        : undefined,
  };
}

export interface LauncherDeps {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  paths?: SunPilotPaths;
  fetchImpl?: typeof fetch;
  openImpl?: (target: string) => Promise<unknown>;
  spawnImpl?: SpawnLike;
  resolveDaemonMainImpl?: () => string;
  existsImpl?: (path: string) => boolean;
  readFileImpl?: (path: string, encoding: BufferEncoding) => string;
  rmImpl?: (path: string, options: { force: boolean }) => void;
  killImpl?: (pid: number, signal: NodeJS.Signals) => boolean;
  /** Override the daemon-identity check used before signaling a PID. */
  isDaemonProcessImpl?: (entry: PidFileEntry) => boolean;
  readConfigImpl?: (paths: SunPilotPaths) => SunPilotConfig;
  log?: (message: string) => void;
}

export async function runLauncher(deps: LauncherDeps = {}): Promise<number> {
  const parsed = parseArgs(deps.argv ?? process.argv.slice(2));
  const command = parsed.command;
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? getSunPilotPaths();
  let configPort = 3737;
  try {
    configPort = (deps.readConfigImpl ?? readSunPilotConfig)(paths).server.port;
  } catch {
    // The daemon will report malformed config in detail; launcher keeps a
    // usable fallback for status/doctor commands.
  }
  const envPort = env.SUNPILOT_PORT === undefined ? undefined : Number(env.SUNPILOT_PORT);
  const port = parsed.port ?? (
    Number.isInteger(envPort) && Number(envPort) > 0 && Number(envPort) <= 65_535
      ? Number(envPort)
      : configPort
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  const webUrl = (
    env.SUNPILOT_WEB_URL ??
    env.SUNPILOT_CONSOLE_URL ??
    DEFAULT_WEB_URL
  ).replace(/\/+$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? console.log;

  // A10: Read the local bearer token (written by the daemon at startup) so
  // the launcher can authenticate against token-gated routes like
  // /v1/diagnostics. Returns undefined when token auth is disabled or the
  // token file is absent.
  function readLocalToken(): string | undefined {
    const tokenPath = (paths as { token?: string }).token;
    if (!tokenPath) return undefined;
    if (!(deps.existsImpl ?? existsSync)(tokenPath)) return undefined;
    try {
      const raw = (deps.readFileImpl ?? readFileSync)(tokenPath, "utf8");
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  async function status(): Promise<boolean> {
    try {
      const token = readLocalToken();
      const response = token
        ? await fetchImpl(`${baseUrl}/healthz`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        : await fetchImpl(`${baseUrl}/healthz`);
      const body = await response.json();
      log(JSON.stringify(body, null, 2));
      return response.ok;
    } catch {
      log("SunPilot daemon is not reachable.");
      return false;
    }
  }

  async function doctor(): Promise<boolean> {
    try {
      const token = readLocalToken();
      const response = token
        ? await fetchImpl(`${baseUrl}/v1/diagnostics`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        : await fetchImpl(`${baseUrl}/v1/diagnostics`);
      const body = await response.json();
      log(JSON.stringify(body, null, 2));
      return response.ok;
    } catch {
      log("SunPilot diagnostics are not reachable.");
      return false;
    }
  }

  function printLogs(): boolean {
    const logPath = join(paths.logs, "daemon.log");
    if (!(deps.existsImpl ?? existsSync)(logPath)) {
      log(`SunPilot daemon log was not found at ${logPath}`);
      return false;
    }
    const content = (deps.readFileImpl ?? readFileSync)(logPath, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
    const tail = lines.slice(-(parsed.lines ?? 80));
    log(tail.join("\n"));
    return true;
  }

  function killDaemon(): boolean {
    let killed = false;
    const kill = deps.killImpl ?? process.kill;
    const isDaemon = deps.isDaemonProcessImpl ?? isDaemonProcess;

    // 1) Try PID file first.
    // P1-12: Verify the PID belongs to a SunPilot daemon before signaling.
    // A reused PID that now belongs to an unrelated process must never be
    // killed — only the stale PID file is removed in that case.
    const pidFile = paths.pidFile;
    if ((deps.existsImpl ?? existsSync)(pidFile)) {
      const raw = (deps.readFileImpl ?? readFileSync)(pidFile, "utf8");
      const entry = parsePidFile(raw);
      if (entry && isDaemon(entry)) {
        try { kill(entry.pid, "SIGTERM"); killed = true; } catch { /* stale */ }
      } else {
        // PID file is stale (PID missing or belongs to a non-daemon process).
        // Do NOT signal — just remove the file.
      }
      (deps.rmImpl ?? rmSync)(pidFile, { force: true });
    }

    return killed;
  }

  function startDaemon(): Promise<number> {
    const daemonMain = (
      deps.resolveDaemonMainImpl ??
      (() => require.resolve("@sunpilot/daemon/main"))
    )();
    const daemonArgs = [daemonMain, "--foreground", "--port", String(port)];
    const child = (deps.spawnImpl ?? spawn)(process.execPath, daemonArgs, {
      cwd: deps.cwd ?? process.cwd(),
      detached: !parsed.foreground,
      stdio: parsed.foreground ? "inherit" : "ignore",
      env: { ...env, SUNPILOT_PORT: String(port) },
    });
    if (parsed.foreground) {
      return new Promise<number>((resolve) => {
        child.once("exit", (code) => resolve(code ?? 0));
      });
    }
    child.unref();
    log(`SunPilot daemon starting at ${baseUrl}`);
    return Promise.resolve(0);
  }

  switch (command) {
    case "start": {
      if (await status()) {
        log("SunPilot daemon is already running.");
        return 0;
      }
      return await startDaemon();
    }
    case "stop": {
      const killed = killDaemon();
      log(killed ? "SunPilot daemon stopped." : "SunPilot daemon was not running.");
      return 0;
    }
    case "restart": {
      log("Stopping SunPilot daemon...");
      killDaemon();
      // A10: Poll until the daemon is actually unreachable (or the deadline
      // elapses) instead of a fixed 1s wait. The fixed wait could either
      // start too early (interrupting in-flight DB writes) or wait too long.
      const deadline = Date.now() + RESTART_POLL_DEADLINE_MS;
      while (Date.now() < deadline) {
        try {
          await fetchImpl(`${baseUrl}/healthz`);
          // Still up — wait briefly and retry.
          await new Promise((r) => setTimeout(r, RESTART_POLL_INTERVAL_MS));
        } catch {
          break; // Daemon is down — safe to start a new one.
        }
      }
      log("Starting SunPilot daemon...");
      return await startDaemon();
    }
    case "status":
      return (await status()) ? 0 : 1;
    case "doctor":
      return (await doctor()) ? 0 : 1;
    case "logs":
      return printLogs() ? 0 : 1;
    case "open": {
      let target = `${webUrl}/`;
      try {
        const parsedTarget = new URL(target);
        // A10: Always read the local bearer token and inject it as a
        // URL fragment so the browser can authenticate against the
        // daemon regardless of whether it's accessed via localhost or
        // a production domain (e.g. tradeagent.asia via nginx).
        const token = readLocalToken();
        if (token) {
          parsedTarget.hash = new URLSearchParams({ "sunpilot-token": token }).toString();
          target = parsedTarget.toString();
        }
      } catch {
        // Preserve the configured target; open() will surface malformed URLs.
      }
      try {
        await (deps.openImpl ?? open)(target);
      } catch {
        log("Browser open is not available on this machine.");
      }
      log(`Opened ${target}`);
      return 0;
    }
    default:
      log("Usage: sun <start|stop|restart|status|doctor|logs|open>");
      return command === "help" ? 0 : 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await runLauncher();
}
