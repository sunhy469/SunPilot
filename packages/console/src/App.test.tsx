import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./App.js";

let root: Root;
let container: HTMLDivElement;

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Console App", () => {
  test("renders daemon status, pending approval, selected run events, artifact link, memory, and skills", async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
      if (path === "/v1/artifacts/artifact_1/content") return new Response("artifact");
      if (path === "/v1/runs/run_1/cancel" && init?.method === "POST") return jsonResponse({ id: "run_1", status: "canceled" });
      if (path === "/readyz") return jsonResponse({ ok: true, workflows: 2 });
      if (path === "/v1/runs") return jsonResponse([{ id: "run_1", title: "Echo run", status: "waiting_approval", createdAt: "2026-06-04T00:00:00.000Z" }]);
      if (path === "/v1/approvals") return jsonResponse([{ id: "approval_1", runId: "run_1", title: "Approve echo", reason: "High risk fixture", risk: "high", status: "pending" }]);
      if (path === "/v1/workflows") return jsonResponse([{ id: "fixture.echo", title: "Fixture Echo Workflow", version: "0.1.0", enabled: true }]);
      if (path === "/v1/artifacts") return jsonResponse([{ id: "artifact_1", runId: "run_1", name: "echo-result.json", type: "json" }]);
      if (path === "/v1/jobs") return jsonResponse([{ id: "job_1", runId: "run_1", status: "interrupted", attempts: 1, updatedAt: "2026-06-04T00:00:00.000Z" }]);
      if (path === "/v1/config") return jsonResponse({ server: { host: "127.0.0.1", port: 3737 }, security: { requireLocalToken: true, allowLan: false }, storage: { home: "/tmp/sunpilot" } });
      if (path === "/v1/skills") {
        return jsonResponse([
          {
            id: "fixture.echo-skill",
            name: "Fixture Echo Skill",
            version: "0.1.0",
            enabled: true,
            manifest: { capabilities: [{ name: "echo.message", title: "Echo message", risk: "low" }] }
          }
        ]);
      }
      if (path === "/v1/runs/run_1") {
        return jsonResponse({
          id: "run_1",
          title: "Echo run",
          status: "waiting_approval",
          createdAt: "2026-06-04T00:00:00.000Z",
          steps: [{ id: "step_1", name: "Approve fixture echo execution", status: "waiting_approval", type: "approval" }],
          events: [{ id: "evt_1", type: "approval.requested", payload: {}, createdAt: "2026-06-04T00:00:00.000Z" }],
          artifacts: [{ id: "artifact_1", name: "echo-result.json", type: "json" }],
          memory: [{ id: "memory_1", key: "fixture.echo.last_message", value: { message: "Echo run" }, createdAt: "2026-06-04T00:00:00.000Z" }]
        });
      }
      throw new Error(`Unexpected fetch ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:sunpilot"), revokeObjectURL: vi.fn() });

    await act(async () => {
      root.render(<App token="test-token" />);
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("守护进程 在线");
      expect(container.textContent).toContain("工作流 2");
      expect(container.textContent).toContain("待审批 1");
      expect(container.textContent).toContain("任务 1");
      expect(container.textContent).toContain("127.0.0.1:3737");
      expect(container.textContent).toContain("局域网 关闭");
      expect(container.textContent).toContain("/tmp/sunpilot");
      expect(container.textContent).toContain("Echo run");
      expect(container.textContent).toContain("Fixture Echo Workflow");
      expect(container.textContent).toContain("已中断");
      expect(container.textContent).toContain("approval.requested");
      expect(container.textContent).toContain("fixture.echo.last_message");
      expect(container.textContent).toContain("Fixture Echo Skill");
    });

    expect(container.querySelector('a[href*="token="]')).toBeNull();
    const artifactButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "echo-result.json");
    expect(artifactButton).toBeDefined();

    await act(async () => {
      artifactButton?.click();
    });
    expect(fetchMock).toHaveBeenCalledWith("/v1/artifacts/artifact_1/content", expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[title='取消运行']")?.click();
    });
    expect(fetchMock).toHaveBeenCalledWith("/v1/runs/run_1/cancel", expect.objectContaining({ method: "POST" }));
  });
});
