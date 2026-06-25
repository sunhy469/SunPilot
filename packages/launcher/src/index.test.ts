import { describe, expect, test, vi } from "vitest";
import { runLauncher } from "./index.js";

const paths = {
  home: "/tmp/sunpilot",
  db: "/tmp/sunpilot/sunpilot.db",
  analytics: "/tmp/sunpilot/analytics",
  vectors: "/tmp/sunpilot/vectors/lance",
  artifacts: "/tmp/sunpilot/artifacts",
  skills: "/tmp/sunpilot/skills",
  logs: "/tmp/sunpilot/logs",
  cache: "/tmp/sunpilot/cache",
  runtime: "/tmp/sunpilot/runtime",
  pidFile: "/tmp/sunpilot/runtime/daemon.pid",
  token: "/tmp/sunpilot/runtime/token",
};

describe("launcher", () => {
  test("status returns success when daemon is reachable", async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, daemon: "alive" }),
    })) as any;
    const code = await runLauncher({
      argv: ["status", "--port", "4111"],
      paths,
      log: (message) => messages.push(message),
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4111/healthz");
    expect(messages.join("\n")).toContain('"daemon": "alive"');
  });

  test("accepts pnpm separator style for compact sun commands", async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, daemon: "alive" }),
    })) as any;
    const code = await runLauncher({
      argv: ["--", "status", "--port", "4111"],
      paths,
      log: (message) => messages.push(message),
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4111/healthz");
  });

  test("prints compact sun usage", async () => {
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["help"],
      paths,
      log: (message) => messages.push(message),
    });
    expect(code).toBe(0);
    expect(messages).toEqual([
      "Usage: sun <start|stop|restart|status|doctor|logs|open>",
    ]);
  });

  test("doctor prints daemon diagnostics", async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        daemon: { status: "ok" },
        database: { status: "ok", latencyMs: 1 },
      }),
    })) as any;
    const code = await runLauncher({
      argv: ["doctor", "--port", "4111"],
      paths,
      log: (message) => messages.push(message),
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4111/v1/diagnostics",
    );
    expect(messages.join("\n")).toContain('"database"');
  });

  test("doctor returns failure when diagnostics are unreachable", async () => {
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["doctor"],
      paths,
      log: (message) => messages.push(message),
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as any,
    });
    expect(code).toBe(1);
    expect(messages).toEqual(["SunPilot diagnostics are not reachable."]);
  });

  test("logs prints the tail of the daemon log", async () => {
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["logs", "--lines", "2"],
      paths,
      log: (message) => messages.push(message),
      existsImpl: (path) => path === "/tmp/sunpilot/logs/daemon.log",
      readFileImpl: () => "line 1\nline 2\nline 3\n",
    });

    expect(code).toBe(0);
    expect(messages).toEqual(["line 2\nline 3"]);
  });

  test("logs returns failure when the daemon log is missing", async () => {
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["logs"],
      paths,
      log: (message) => messages.push(message),
      existsImpl: () => false,
    });

    expect(code).toBe(1);
    expect(messages).toEqual([
      "SunPilot daemon log was not found at /tmp/sunpilot/logs/daemon.log",
    ]);
  });

  test("status returns failure when daemon is unreachable", async () => {
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["status"],
      paths,
      log: (message) => messages.push(message),
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as any,
    });
    expect(code).toBe(1);
    expect(messages).toEqual(["SunPilot daemon is not reachable."]);
  });

  test("start spawns daemon when status is offline", async () => {
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref })) as any;
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["start"],
      env: { SUNPILOT_PORT: "3999" },
      cwd: "/repo",
      paths,
      log: (message) => messages.push(message),
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as any,
      spawnImpl,
      resolveDaemonMainImpl: () =>
        "/repo/node_modules/@sunpilot/daemon/dist/main.js",
    });
    expect(code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [
        "/repo/node_modules/@sunpilot/daemon/dist/main.js",
        "--foreground",
        "--port",
        "3999",
      ],
      expect.objectContaining({
        cwd: "/repo",
        detached: true,
        stdio: "ignore",
      }),
    );
    expect(unref).toHaveBeenCalled();
    expect(messages).toContain(
      "SunPilot daemon starting at http://127.0.0.1:3999",
    );
  });

  test("start foreground passes port and waits for daemon exit", async () => {
    const spawnImpl = vi.fn(() => ({
      once: (_event: "exit", callback: (code: number) => void) => callback(0),
    })) as any;
    const code = await runLauncher({
      argv: ["start", "--foreground", "--port", "4112"],
      cwd: "/repo",
      paths,
      log: () => {},
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as any,
      spawnImpl,
      resolveDaemonMainImpl: () =>
        "/repo/node_modules/@sunpilot/daemon/dist/main.js",
    });
    expect(code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [
        "/repo/node_modules/@sunpilot/daemon/dist/main.js",
        "--foreground",
        "--port",
        "4112",
      ],
      expect.objectContaining({
        cwd: "/repo",
        detached: false,
        stdio: "inherit",
      }),
    );
  });

  test("open launches the default domain web URL without a token", async () => {
    const openImpl = vi.fn(async () => undefined);
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["open", "--port", "4113"],
      env: { SUNPILOT_PORT: "3737" },
      paths,
      log: (message) => messages.push(message),
      openImpl,
    });
    expect(code).toBe(0);
    expect(openImpl).toHaveBeenCalledWith("https://tradeagent.asia/");
    expect(messages).toEqual(["Opened https://tradeagent.asia/"]);
  });

  test("open allows overriding the public web URL", async () => {
    const openImpl = vi.fn(async () => undefined);
    const code = await runLauncher({
      argv: ["open"],
      env: { SUNPILOT_WEB_URL: "http://127.0.0.1:3737/" },
      paths,
      log: () => {},
      openImpl,
    });

    expect(code).toBe(0);
    expect(openImpl).toHaveBeenCalledWith("http://127.0.0.1:3737/");
  });

  test("open still prints the URL when no local browser is available", async () => {
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["open"],
      env: {},
      paths,
      log: (message) => messages.push(message),
      openImpl: vi.fn(async () => {
        throw new Error("no browser");
      }),
    });

    expect(code).toBe(0);
    expect(messages).toEqual([
      "Browser open is not available on this machine.",
      "Opened https://tradeagent.asia/",
    ]);
  });

  test("stop removes pid file after signalling daemon", async () => {
    const killImpl = vi.fn(() => true);
    const rmImpl = vi.fn();
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["stop"],
      paths,
      log: (message) => messages.push(message),
      existsImpl: () => true,
      readFileImpl: () => "123",
      killImpl,
      rmImpl,
    });
    expect(code).toBe(0);
    expect(killImpl).toHaveBeenCalledWith(123, "SIGTERM");
    expect(rmImpl).toHaveBeenCalledWith(paths.pidFile, { force: true });
    expect(messages).toEqual(["SunPilot daemon stopped."]);
  });

  test("stop removes a stale pid file when the daemon process is gone", async () => {
    const killImpl = vi.fn(() => {
      throw new Error("missing process");
    });
    const rmImpl = vi.fn();
    const messages: string[] = [];
    const code = await runLauncher({
      argv: ["stop"],
      paths,
      log: (message) => messages.push(message),
      existsImpl: () => true,
      readFileImpl: () => "123",
      killImpl,
      rmImpl,
    });

    expect(code).toBe(0);
    expect(killImpl).toHaveBeenCalledWith(123, "SIGTERM");
    expect(rmImpl).toHaveBeenCalledWith(paths.pidFile, { force: true });
    expect(messages).toEqual([
      "SunPilot daemon was not running.",
    ]);
  });
});
