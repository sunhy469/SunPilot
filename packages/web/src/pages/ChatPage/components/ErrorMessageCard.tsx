import { Alert } from "antd";

export function ErrorMessageCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-message-card">
      <Alert
        type="error"
        showIcon
        title="请求失败"
        description={message}
        action={
          onRetry ? (
            <button
              type="button"
              className="sp-button sp-button--md sp-button--warm"
              onClick={onRetry}
            >
              重试
            </button>
          ) : undefined
        }
      />
    </div>
  );
}
