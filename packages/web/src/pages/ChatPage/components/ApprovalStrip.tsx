import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import type { AgentApproval } from "../../../features/agent-runtime/api";
import "./ApprovalStrip.css";

interface ApprovalStripProps {
  approvals: AgentApproval[];
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}

export function ApprovalStrip({
  approvals = [],
  onApprove,
  onReject,
}: ApprovalStripProps) {
  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length === 0) return null;

  return (
    <div className="approval-strip" aria-label="Pending approvals">
      {pending.map((approval) => (
        <div className="approval-strip__item" key={approval.id}>
          <div className="approval-strip__body">
            <span className={`approval-strip__risk is-${approval.risk}`}>
              {approval.risk}
            </span>
            <span className="approval-strip__title">{approval.title}</span>
          </div>
          <div className="approval-strip__actions">
            <button
              aria-label={`Approve ${approval.title}`}
              className="approval-strip__button is-approve"
              onClick={() => onApprove(approval.id)}
              title="Approve"
              type="button"
            >
              <CheckOutlined />
            </button>
            <button
              aria-label={`Reject ${approval.title}`}
              className="approval-strip__button is-reject"
              onClick={() => onReject(approval.id)}
              title="Reject"
              type="button"
            >
              <CloseOutlined />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
