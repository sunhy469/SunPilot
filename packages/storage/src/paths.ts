import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SunPilotPaths {
  home: string;
  db: string;
  analytics: string;
  vectors: string;
  artifacts: string;
  skills: string;
  logs: string;
  cache: string;
  runtime: string;
  pidFile: string;
  /** Local bearer token used to authenticate HTTP/WS requests to the daemon. */
  token: string;
}

export interface SunPilotConfig {
  version: 1;
  server: {
    host: "127.0.0.1";
    /** Used at daemon startup unless overridden by SUNPILOT_PORT or --port. */
    port: number;
  };
  security: {
    /** Used at daemon startup unless SUNPILOT_DISABLE_TOKEN_AUTH is explicit. */
    requireLocalToken: boolean;
    allowLan: false;
  };
  skills: {
    /** Absolute paths, or paths relative to SUNPILOT_HOME. */
    directories: string[];
    /** Watch configured directories and reload registry changes. */
    autoReload: boolean;
  };
  storage: {
    home: string;
  };
}

export function getSunPilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUNPILOT_HOME ?? join(homedir(), ".sunpilot");
}

export function getSunPilotPaths(home = getSunPilotHome()): SunPilotPaths {
  return {
    home,
    db: join(home, "sunpilot.db"),
    analytics: join(home, "analytics"),
    vectors: join(home, "vectors", "lance"),
    artifacts: join(home, "artifacts"),
    skills: join(home, "skills"),
    logs: join(home, "logs"),
    cache: join(home, "cache"),
    runtime: join(home, "runtime"),
    pidFile: join(home, "runtime", "daemon.pid"),
    token: join(home, "runtime", "token")
  };
}

export function defaultSunPilotConfig(paths = getSunPilotPaths()): SunPilotConfig {
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 3737 },
    security: { requireLocalToken: true, allowLan: false },
    skills: { directories: [paths.skills], autoReload: true },
    storage: { home: paths.home }
  };
}

export function readSunPilotConfig(paths = getSunPilotPaths()): SunPilotConfig {
  ensureSunPilotHome(paths);
  return normalizeSunPilotConfig(JSON.parse(readFileSync(configPath(paths), "utf8")) as Partial<SunPilotConfig>, paths);
}

export function writeSunPilotConfig(config: SunPilotConfig, paths = getSunPilotPaths()): SunPilotConfig {
  ensureSunPilotHome(paths);
  const normalized = normalizeSunPilotConfig(config, paths);
  writeFileSync(configPath(paths), JSON.stringify(normalized, null, 2));
  return normalized;
}

export function updateSunPilotConfig(patch: Partial<SunPilotConfig>, paths = getSunPilotPaths()): SunPilotConfig {
  const current = readSunPilotConfig(paths);
  const safePatch = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  return writeSunPilotConfig(
    {
      ...current,
      ...safePatch,
      server: { ...current.server, ...safePatch.server, host: "127.0.0.1" },
      security: { ...current.security, ...safePatch.security, allowLan: false },
      skills: { ...current.skills, ...safePatch.skills },
      storage: { ...current.storage, ...safePatch.storage, home: paths.home }
    },
    paths
  );
}

export function ensureSunPilotHome(paths = getSunPilotPaths()): SunPilotPaths {
  for (const dir of [
    paths.home,
    paths.analytics,
    paths.vectors,
    paths.artifacts,
    paths.skills,
    paths.logs,
    paths.cache,
    paths.runtime
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const path = configPath(paths);
  if (!existsSync(path)) {
    writeFileSync(
      path,
      JSON.stringify(defaultSunPilotConfig(paths), null, 2)
    );
  }
  for (const logName of ["daemon.log", "audit.log", "skill.log"]) {
    const logPath = join(paths.logs, logName);
    if (!existsSync(logPath)) {
      writeFileSync(logPath, "");
    }
  }

  return paths;
}

function configPath(paths: SunPilotPaths): string {
  return join(paths.home, "config.json");
}

function normalizeSunPilotConfig(input: Partial<SunPilotConfig>, paths: SunPilotPaths): SunPilotConfig {
  const defaults = defaultSunPilotConfig(paths);
  return {
    version: 1,
    server: {
      host: "127.0.0.1",
      port: positiveInteger(input.server?.port, defaults.server.port)
    },
    security: {
      requireLocalToken: input.security?.requireLocalToken ?? defaults.security.requireLocalToken,
      allowLan: false
    },
    skills: {
      directories: stringArray(input.skills?.directories, defaults.skills.directories),
      autoReload: input.skills?.autoReload ?? defaults.skills.autoReload
    },
    storage: {
      home: paths.home
    }
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535
    ? value
    : fallback;
}

function stringArray(value: string[] | undefined, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? value : fallback;
}
