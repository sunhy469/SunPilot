import { describe, expect, test } from "vitest";
import { SummaryStaleDetector } from "./summary-stale-detector.js";
import type { StaleDetectionInput } from "./summary-stale-detector.js";

function makeInput(overrides: Partial<StaleDetectionInput> = {}): StaleDetectionInput {
  return {
    summary: {
      id: "summary_1",
      content: "User wants to set up CI/CD for a Node.js project using GitHub Actions.",
      createdAt: "2026-06-25T00:00:00.000Z",
      metadata: {},
      ...overrides.summary,
    },
    newMessages: [],
    newToolResults: [],
    ...overrides,
  };
}

describe("SummaryStaleDetector", () => {
  const detector = new SummaryStaleDetector();

  describe("not stale", () => {
    test("returns not stale for empty new messages and tool results", () => {
      const result = detector.checkStale(makeInput());
      expect(result.stale).toBe(false);
      expect(result.severity).toBe("info");
      expect(result.reasons).toHaveLength(0);
      expect(result.keepWithWarning).toBe(false);
    });

    test("returns not stale for unrelated messages", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [
            { role: "user", content: "Can you explain more about that?" },
            { role: "assistant", content: "Sure, here are more details..." },
          ],
        }),
      );
      expect(result.stale).toBe(false);
    });
  });

  describe("goal change detection", () => {
    test("detects English goal change: actually", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "Actually, let's use Docker Compose instead." }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
      expect(result.keepWithWarning).toBe(true);
      expect(result.reasons.some((r) => r.includes("Goal changed"))).toBe(true);
    });

    test("detects English goal change: change of plans", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "Change of plans — we'll deploy to AWS instead." }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("detects English goal change: on second thought", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "On second thought, let's not do that." }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("detects English goal change: instead", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "Instead, use pnpm as the package manager." }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("detects Chinese goal change: 其实", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "其实我们应该用Kubernetes部署。" }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("detects Chinese goal change: 算了", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "算了，不搞这个了。" }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });
  });

  describe("user correction detection", () => {
    test("detects English correction: no, that's not right", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "No, that's not right. The port should be 8080." }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
      expect(result.reasons.some((r) => r.includes("corrected prior"))).toBe(true);
    });

    test("detects English correction: you misunderstood", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "You misunderstood — I wanted Python, not Node.js." }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("detects English correction: correction", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "Correction: the API endpoint is /v2/users." }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("detects Chinese correction: 不对", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "不对，应该是8080端口。" }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("detects Chinese correction: 我指的是", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [{ role: "user", content: "我指的是Python而不是Node.js。" }],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });
  });

  describe("fact change detection via tool results", () => {
    test("detects fact change from tool results: no longer", () => {
      const result = detector.checkStale(
        makeInput({
          newToolResults: [
            { skillId: "check_deploy", summary: "The service is no longer running on port 3000.", status: "completed" },
          ],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("warning");
      expect(result.reasons.some((r) => r.includes("Tool results changed"))).toBe(true);
    });

    test("detects fact change from tool results: deprecated", () => {
      const result = detector.checkStale(
        makeInput({
          newToolResults: [
            { skillId: "verify_config", summary: "Config key 'old_format' is deprecated.", status: "completed" },
          ],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("warning");
    });

    test("ignores failed tool results", () => {
      const result = detector.checkStale(
        makeInput({
          newToolResults: [
            { skillId: "check_api", summary: "The endpoint is no longer available.", status: "failed" },
          ],
        }),
      );
      expect(result.stale).toBe(false);
    });

    test("detects Chinese fact change: 已经", () => {
      const result = detector.checkStale(
        makeInput({
          newToolResults: [
            { skillId: "check", summary: "该服务已经停止运行。", status: "completed" },
          ],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("warning");
    });
  });

  describe("preference conflict detection", () => {
    test("detects new explicit preference that may override summary", () => {
      const result = detector.checkStale(
        makeInput({
          summary: {
            id: "s1",
            content: "User wants to use GitHub Actions for CI/CD in the Node.js project.",
            createdAt: "2026-06-25T00:00:00.000Z",
          },
          newMessages: [
            // "github" and "actions" both appear in summary → topic overlap >= 2
            { role: "user", content: "I prefer Jenkins over GitHub Actions for CI/CD." },
          ],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("warning");
    });

    test("does not flag preference when topics don't overlap with summary", () => {
      const result = detector.checkStale(
        makeInput({
          summary: {
            id: "s1",
            content: "User prefers to use GitHub Actions for CI/CD.",
            createdAt: "2026-06-25T00:00:00.000Z",
          },
          newMessages: [
            { role: "user", content: "I prefer dark mode for the editor." },
          ],
        }),
      );
      // "dark mode editor" has no overlap with "github actions CI/CD"
      expect(result.stale).toBe(false);
    });

    test("detects always/never keywords", () => {
      const result = detector.checkStale(
        makeInput({
          summary: {
            id: "s1",
            content: "The application uses port 3000 for development.",
            createdAt: "2026-06-25T00:00:00.000Z",
          },
          newMessages: [
            // "port" and "development" overlap with summary, no goal-change words
            { role: "user", content: "Always use port 8080 for development." },
          ],
        }),
      );
      // "port" and "development" both overlap with summary → topic overlap >= 2
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("warning");
    });
  });

  describe("checkFromMessages convenience method", () => {
    test("delegates to checkStale correctly", () => {
      const result = detector.checkFromMessages({
        summaryId: "s1",
        summaryContent: "Old summary content.",
        summaryCreatedAt: "2026-06-25T00:00:00.000Z",
        newMessagesSince: [
          { role: "user", content: "Actually, change of plans. Let's do it differently." },
        ],
      });
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("accepts optional tool results", () => {
      const result = detector.checkFromMessages({
        summaryId: "s1",
        summaryContent: "Old content.",
        summaryCreatedAt: "2026-06-25T00:00:00.000Z",
        newMessagesSince: [],
        newToolResultsSince: [
          { skillId: "check_ver", summary: "The library version is no longer supported.", status: "completed" },
        ],
      });
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("warning");
    });
  });

  describe("edge cases", () => {
    test("goal change + correction together → critical", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [
            { role: "user", content: "Actually, let's switch. No, that's wrong — use Rust." },
          ],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("only assistant messages do not trigger stale", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [
            { role: "assistant", content: "Actually, I think we should change the approach." },
          ],
        }),
      );
      // Assistant messages are not checked for goal change or correction (only user messages are)
      expect(result.stale).toBe(false);
    });

    test("goal change triggers only on user messages", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [
            { role: "assistant", content: "Actually, let's reconsider the plan." },
            { role: "user", content: "Yes, that's fine." },
          ],
        }),
      );
      // "Actually" in assistant message is ignored; "Yes, that's fine" has no goal-change pattern
      expect(result.stale).toBe(false);
    });

    test("multiple reasons are accumulated", () => {
      const result = detector.checkStale(
        makeInput({
          newMessages: [
            { role: "user", content: "Actually, change of plans." },
            { role: "user", content: "No, that's wrong." },
          ],
        }),
      );
      expect(result.stale).toBe(true);
      expect(result.severity).toBe("critical");
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });
  });
});
