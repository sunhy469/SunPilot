import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeArtifact } from "./artifacts.js";
import { getSunPilotPaths } from "./paths.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sunpilot-artifact-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("writeArtifact", () => {
  test("writes content with storage metadata, checksum, and version", () => {
    const paths = getSunPilotPaths(home);
    const artifact = writeArtifact(paths, {
      runId: "run_1",
      conversationId: "conv_1",
      type: "markdown",
      name: "report.md",
      content: "# Report\n",
      mimeType: "text/markdown",
      metadata: { producer: "test" },
    });

    expect(existsSync(artifact.path)).toBe(true);
    expect(artifact).toEqual(
      expect.objectContaining({
        runId: "run_1",
        conversationId: "conv_1",
        storageKey: "runs/run_1/report.md",
        checksum:
          "497b7725a00101d6cf82489ef502fb0918962b10aaa7279962ab5ec3edc62533",
        version: 1,
        sizeBytes: 9,
      }),
    );

    const next = writeArtifact(paths, {
      runId: "run_1",
      type: "markdown",
      name: "report.md",
      content: "# Report v2\n",
    });

    expect(next.name).toBe("report.md");
    expect(next.version).toBe(2);
    expect(next.storageKey).toBe("runs/run_1/report.v2.md");
    expect(next.path.endsWith("report.v2.md")).toBe(true);
  });
});
