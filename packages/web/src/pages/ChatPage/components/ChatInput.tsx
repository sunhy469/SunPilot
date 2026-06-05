import { Button, Input } from "antd";
import { SendOutlined } from "@ant-design/icons";
import { useState } from "react";

export function ChatInput({ disabled, onSend }: { disabled?: boolean; onSend: (message: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="chat-input"
      onSubmit={(event) => {
        event.preventDefault();
        onSend(value);
        setValue("");
      }}
    >
      <Input.TextArea aria-label="Message" value={value} onChange={(event) => setValue(event.target.value)} rows={2} />
      <Button aria-label="Send" htmlType="submit" type="primary" icon={<SendOutlined />} disabled={disabled || !value.trim()} />
    </form>
  );
}
