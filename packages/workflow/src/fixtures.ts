import type { BusinessWorkflow } from "./registry.js";

function messageFromInput(input: unknown): string {
  if (typeof input === "object" && input && "text" in input && typeof input.text === "string") {
    return input.text;
  }
  if (typeof input === "object" && input && "message" in input && typeof input.message === "string") {
    return input.message;
  }
  return "fixture echo";
}

export const fixtureEchoWorkflow: BusinessWorkflow = {
  id: "fixture.echo",
  title: "Fixture Echo Workflow",
  version: "0.1.0",
  description: "Development fixture that requests approval, runs the echo skill, and stores an artifact.",
  async match() {
    return { score: 1, reason: "fixture workflow" };
  },
  async plan(input) {
    const message = messageFromInput(input);
    return {
      runTitle: `Echo: ${message.slice(0, 40)}`,
      riskSummary: { risk: "high", reason: "Fixture workflow intentionally exercises approval flow." },
      expectedArtifacts: [{ name: "echo-result.json", type: "json" }],
      steps: [
        {
          id: "approval.fixture.high_risk",
          name: "Approve fixture echo execution",
          type: "approval",
          input: {
            title: "Approve fixture echo Skill",
            reason: "This high-risk fixture step validates SunPilot approval and audit flow.",
            requestedAction: { skillId: "fixture.echo-skill", capability: "echo.message", message }
          },
          risk: "high"
        },
        {
          id: "skill.fixture.echo",
          name: "Execute Echo Skill",
          type: "skill",
          providerId: "fixture.echo-skill",
          capability: "echo.message",
          input: { message },
          dependsOn: ["approval.fixture.high_risk"],
          risk: "low"
        }
      ]
    };
  }
};

export const fixtureApprovalWorkflow: BusinessWorkflow = {
  ...fixtureEchoWorkflow,
  id: "fixture.approval",
  title: "Fixture Approval Workflow",
  description: "Alias fixture focused on approval behavior."
};

export const fixtureShellPermissionWorkflow: BusinessWorkflow = {
  id: "fixture.shell-permission",
  title: "Fixture Shell Permission Workflow",
  version: "0.1.0",
  description: "Development fixture that proves shell permission declarations are denied by the MVP runner.",
  async match() {
    return { score: 1, reason: "fixture permission workflow" };
  },
  async plan() {
    return {
      runTitle: "Shell permission denial fixture",
      riskSummary: { risk: "critical", reason: "Fixture intentionally declares shell permission." },
      steps: [
        {
          id: "approval.fixture.shell_permission",
          name: "Approve shell permission fixture",
          type: "approval",
          input: {
            title: "Approve shell permission fixture",
            reason: "This fixture validates daemon permission denial for shell access.",
            requestedAction: { skillId: "fixture.shell-skill", capability: "shell.noop" }
          },
          risk: "critical"
        },
        {
          id: "skill.fixture.shell_permission",
          name: "Attempt Shell Permission Skill",
          type: "skill",
          providerId: "fixture.shell-skill",
          capability: "shell.noop",
          input: { message: "permission gate" },
          dependsOn: ["approval.fixture.shell_permission"],
          risk: "critical"
        }
      ]
    };
  }
};

export const fixtureFilePermissionWorkflow: BusinessWorkflow = {
  id: "fixture.file-permission",
  title: "Fixture File Permission Workflow",
  version: "0.1.0",
  description: "Development fixture that proves file access must pass through daemon permission declarations.",
  async match() {
    return { score: 1, reason: "fixture file permission workflow" };
  },
  async plan() {
    return {
      runTitle: "File permission denial fixture",
      riskSummary: { risk: "high", reason: "Fixture intentionally attempts an undeclared file write." },
      steps: [
        {
          id: "approval.fixture.file_permission",
          name: "Approve file permission fixture",
          type: "approval",
          input: {
            title: "Approve file permission fixture",
            reason: "This fixture validates daemon permission denial for file writes.",
            requestedAction: { skillId: "fixture.file-skill", capability: "files.writeOutside" }
          },
          risk: "high"
        },
        {
          id: "skill.fixture.file_permission",
          name: "Attempt File Permission Skill",
          type: "skill",
          providerId: "fixture.file-skill",
          capability: "files.writeOutside",
          input: { path: "/tmp/sunpilot-denied.txt", content: "denied" },
          dependsOn: ["approval.fixture.file_permission"],
          risk: "high"
        }
      ]
    };
  }
};
