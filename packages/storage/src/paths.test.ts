import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureSunPilotHome, getSunPilotPaths, readSunPilotConfig, updateSunPilotConfig } from "./paths.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sunpilot-paths-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("local runtime paths", () => {
  test("creates runtime directories without auth token files", () => {
    const paths = getSunPilotPaths(home);
    ensureSunPilotHome(paths);
    expect(existsSync(paths.runtime)).toBe(true);
    expect(paths.pidFile).toBe(join(home, "runtime", "daemon.pid"));
    expect(paths.token).toBe(join(home, "runtime", "token"));
  });
});

describe("SunPilot config file", () => {
  test("creates default config and normalizes managed updates", () => {
    const paths = getSunPilotPaths(home);
    ensureSunPilotHome(paths);

    expect(readSunPilotConfig(paths)).toMatchObject({
      version: 1,
      server: { host: "127.0.0.1", port: 3737 },
      security: { requireLocalToken: true, allowLan: false },
      storage: { home }
    });

    const updated = updateSunPilotConfig(
      {
        server: { host: "0.0.0.0", port: 4111 },
        security: { requireLocalToken: false, allowLan: true },
        skills: { directories: ["/tmp/skills"], autoReload: false }
      } as any,
      paths
    );

    expect(updated).toMatchObject({
      server: { host: "127.0.0.1", port: 4111 },
      security: { requireLocalToken: false, allowLan: false },
      skills: { directories: ["/tmp/skills"], autoReload: false },
      storage: { home }
    });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toMatchObject(updated);
  });
});
