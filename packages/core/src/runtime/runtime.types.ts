export type {
  ApprovalRecord,
  RunRecord,
  StepRecord,
  SunPilotEvent,
} from "@sunpilot/protocol";

export type LegacyWorkflowMode =
  | "plan"
  | "auto"
  | "approval_required"
  | "dry_run";
