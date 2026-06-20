import { Alert, Button, Tag, Space, Typography, Flex } from "antd";
import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import type { AgentApproval } from "../../../../features/agent-runtime/api";
import "./ApprovalStrip.scss";

const { Text } = Typography;

interface ApprovalStripProps {
  approvals: AgentApproval[];
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}

const riskColor: Record<string, string> = {
  low: "blue",
  medium: "orange",
  high: "red",
  critical: "red",
};

export function ApprovalStrip({
  approvals = [],
  onApprove,
  onReject,
}: ApprovalStripProps) {
  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length === 0) return null;

  return (
    <Flex vertical gap={8} className="approval-strip">
      {pending.map((approval) => (
        <Alert
          key={approval.id}
          type="warning"
          showIcon
          message={
            <Space>
              <Tag color={riskColor[approval.risk] ?? "default"}>{approval.risk}</Tag>
              <Text>{approval.title}</Text>
            </Space>
          }
          action={
            <Space>
              <Button
                type="primary"
                size="small"
                icon={<CheckOutlined />}
                onClick={() => onApprove(approval.id)}
              >
                Approve
              </Button>
              <Button
                danger
                size="small"
                icon={<CloseOutlined />}
                onClick={() => onReject(approval.id)}
              >
                Reject
              </Button>
            </Space>
          }
        />
      ))}
    </Flex>
  );
}
