import { Alert, Button } from "antd";

export function ErrorMessageCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert
      type="error"
      showIcon
      title="请求失败"
      description={message}
      action={
        onRetry ? (
          <Button size="small" onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    />
  );
}
