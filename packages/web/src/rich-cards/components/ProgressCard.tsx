import { CheckCircleFilled, LoadingOutlined } from "@ant-design/icons";
import type { ProgressCardData, ProgressStep } from "../types";
import { RichCardShell } from "./RichCardShell";

const statusIcon = (status: ProgressStep["status"]) => {
  switch (status) {
    case "done":
      return <CheckCircleFilled className="rich-progress__icon is-done" />;
    case "active":
      return <LoadingOutlined className="rich-progress__icon is-active" />;
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
      <div className="rich-progress">
        {data.steps.map((step, idx) => (
          <div key={`${step.title}-${idx}`} className="rich-progress__step">
            {statusIcon(step.status)}
            <div className="rich-progress__copy">
              <span className={`rich-progress__label is-${step.status}`}>
                {step.title}
              </span>
              {step.description && (
                <span className="rich-progress__description">
                  {step.description}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}
