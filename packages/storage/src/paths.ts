import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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
  tokenFile: string;
}

export interface SunPilotConfig {
  version: 1;
  server: {
    host: "127.0.0.1";
    port: number;
  };
  security: {
    requireLocalToken: boolean;
    allowLan: false;
  };
  skills: {
    directories: string[];
    autoReload: boolean;
  };
  workflows: {
    directories: string[];
    autoReload: boolean;
  };
  storage: {
    home: string;
  };
}

export function getSunPilotHome(): string {
  return process.env.SUNPILOT_HOME ?? join(homedir(), ".sunpilot");
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
    tokenFile: join(home, "runtime", "auth-token")
  };
}

export function defaultSunPilotConfig(paths = getSunPilotPaths()): SunPilotConfig {
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 3737 },
    security: { requireLocalToken: true, allowLan: false },
    skills: { directories: [paths.skills], autoReload: true },
    workflows: { directories: [join(paths.home, "workflows")], autoReload: true },
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
  return writeSunPilotConfig(
    {
      ...current,
      ...patch,
      server: { ...current.server, ...patch.server },
      security: { ...current.security, ...patch.security },
      skills: { ...current.skills, ...patch.skills },
      workflows: { ...current.workflows, ...patch.workflows },
      storage: { ...current.storage, ...patch.storage }
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
    workflows: {
      directories: stringArray(input.workflows?.directories, defaults.workflows.directories),
      autoReload: input.workflows?.autoReload ?? defaults.workflows.autoReload
    },
    storage: {
      home: paths.home
    }
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringArray(value: string[] | undefined, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? value : fallback;
}

export function ensureLocalToken(paths = getSunPilotPaths()): string {
  ensureSunPilotHome(paths);
  if (existsSync(paths.tokenFile)) {
    chmodSync(paths.tokenFile, 0o600);
    return readFileSync(paths.tokenFile, "utf8").trim();
  }
  const token = `sun_${randomBytes(32).toString("hex")}`;
  writeFileSync(paths.tokenFile, token, { mode: 0o600 });
  chmodSync(paths.tokenFile, 0o600);
  return token;
}
