import { Steps } from "antd";
import { CheckCircleFilled, LoadingOutlined } from "@ant-design/icons";
import type { ProgressCardData, ProgressStep } from "../types";
import { RichCardShell } from "./RichCardShell";

const stepStatusIcon = (status: ProgressStep["status"]) => {
  switch (status) {
    case "done":
      return <CheckCircleFilled style={{ color: "#10b981" }} />;
    case "active":
      return <LoadingOutlined style={{ color: "#2563eb" }} />;
    case "error":
      return <span className="rich-progress__dot is-error" />;
    case "pending":
    default:
      return <span className="rich-progress__dot" />;
  }
};

export function ProgressCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: ProgressCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <Steps
        direction="vertical"
        size="small"
        current={data.steps.findIndex((s) => s.status !== "done")}
        items={data.steps.map((step) => ({
          title: step.title,
          description: step.description,
          status: step.status === "error" ? "error" : step.status === "done" ? "finish" : step.status === "active" ? "process" : "wait",
          icon: stepStatusIcon(step.status),
        }))}
      />
    </RichCardShell>
  );
}
