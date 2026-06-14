import { useState, useCallback, useRef } from "react";
import { Input, Button, Flex } from "antd";
import { SendOutlined, StopOutlined } from "@ant-design/icons";
import "./ChatComposer.css";

const { TextArea } = Input;

export function ChatComposer({
  placeholder = "向 SunPilot 提问...",
  disabled,
  streaming,
  variant = "default",
  value,
  onChange,
  onSend,
  onStop,
}: {
  placeholder?: string;
  disabled?: boolean;
  streaming?: boolean;
  variant?: "default" | "welcome";
  value?: string;
  onChange?: (value: string) => void;
  onSend: (text: string) => void;
  onStop?: () => void;
}) {
  const [internalValue, setInternalValue] = useState("");
  const textareaRef = useRef<any>(null);
  const isControlled = value !== undefined;
  const currentValue = value ?? internalValue;
  const setCurrentValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  const handleSend = useCallback(() => {
    const text = currentValue.trim();
    if (!text || disabled) return;
    onSend(text);
    setCurrentValue("");
  }, [currentValue, disabled, onSend, setCurrentValue]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const isWelcome = variant === "welcome";

  return (
    <Flex gap={8} className={`chat-composer${isWelcome ? " chat-composer--welcome" : ""}`}>
      <TextArea
        ref={textareaRef}
        className="chat-composer__input"
        aria-label="Message"
        placeholder={placeholder}
        value={currentValue}
        rows={isWelcome ? 2 : 1}
        disabled={disabled}
        autoSize={{ minRows: 1, maxRows: 4 }}
        onChange={(e) => setCurrentValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {streaming && onStop ? (
        <Button
          type="primary"
          danger
          shape="circle"
          size="large"
          icon={<StopOutlined />}
          aria-label="Stop"
          onClick={onStop}
        />
      ) : (
        <Button
          type="primary"
          shape="circle"
          size="large"
          icon={<SendOutlined />}
          aria-label="Send"
          disabled={disabled || !currentValue.trim()}
          onClick={handleSend}
        />
      )}
    </Flex>
  );
}
