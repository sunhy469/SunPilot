import { Alert } from "antd";

export function ErrorState({ message }: { message: string }) {
  return message ? <Alert type="error" showIcon title={message} /> : null;
}
