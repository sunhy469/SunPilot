import { Badge } from "antd";
import type { AgentStatus } from "../types";

export function AgentStatusBar({ status }: { status: AgentStatus }) {
  const state = status === "online" ? "success" : status === "thinking" ? "processing" : "default";
  return <Badge status={state} text={status} />;
}
