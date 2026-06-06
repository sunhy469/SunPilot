#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import open from "open";
import { getSunPilotPaths, type SunPilotPaths } from "@sunpilot/storage";

type SpawnLike = typeof spawn;
const require = createRequire(import.meta.url);

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
  log?: (message: string) => void;
}

export async function runLauncher(deps: LauncherDeps = {}): Promise<number> {
  const parsed = parseArgs(deps.argv ?? process.argv.slice(2));
  const command = parsed.command;
  const env = deps.env ?? process.env;
  const port = parsed.port ?? Number(env.SUNPILOT_PORT ?? "3737");
  const baseUrl = `http://127.0.0.1:${port}`;
  const webUrl = (
    env.SUNPILOT_WEB_URL ??
    env.SUNPILOT_CONSOLE_URL ??
    "https://tradeagent.asia"
  ).replace(/\/+$/, "");
  const paths = deps.paths ?? getSunPilotPaths();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? console.log;

  async function status(): Promise<boolean> {
    try {
      const response = await fetchImpl(`${baseUrl}/healthz`);
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
      const response = await fetchImpl(`${baseUrl}/v1/diagnostics`);
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

  switch (command) {
    case "start": {
      if (await status()) {
        return 0;
      }
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
        return await new Promise<number>((resolve) => {
          child.once("exit", (code) => resolve(code ?? 0));
        });
      }
      child.unref();
      log(`SunPilot daemon starting at ${baseUrl}`);
      return 0;
    }
    case "stop": {
      if ((deps.existsImpl ?? existsSync)(paths.pidFile)) {
        const pid = Number(
          (deps.readFileImpl ?? readFileSync)(paths.pidFile, "utf8"),
        );
        try {
          (deps.killImpl ?? process.kill)(pid, "SIGTERM");
          (deps.rmImpl ?? rmSync)(paths.pidFile, { force: true });
          log("SunPilot daemon stop signal sent.");
        } catch {
          (deps.rmImpl ?? rmSync)(paths.pidFile, { force: true });
          log(
            "SunPilot daemon pid file exists, but the process is not running.",
          );
        }
      } else {
        log("SunPilot daemon pid file was not found.");
      }
      return 0;
    }
    case "status":
      return (await status()) ? 0 : 1;
    case "doctor":
      return (await doctor()) ? 0 : 1;
    case "logs":
      return printLogs() ? 0 : 1;
    case "open": {
      const target = `${webUrl}/`;
      try {
        await (deps.openImpl ?? open)(target);
      } catch {
        log("Browser open is not available on this machine.");
      }
      log(`Opened ${target}`);
      return 0;
    }
    default:
      log("Usage: sun <start|stop|status|doctor|logs|open>");
      return command === "help" ? 0 : 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await runLauncher();
}
