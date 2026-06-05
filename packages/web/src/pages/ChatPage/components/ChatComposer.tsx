import { SendOutlined, StopOutlined } from "@ant-design/icons";
import { useState, useCallback, useRef, useEffect } from "react";
import "./ChatComposer.css";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isControlled = value !== undefined;
  const currentValue = value ?? internalValue;
  const setCurrentValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [currentValue, adjustHeight]);

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
    <div className={`chat-composer${isWelcome ? " chat-composer--welcome" : ""}`}>
      <textarea
        ref={textareaRef}
        className="chat-composer__input"
        aria-label="Message"
        placeholder={placeholder}
        value={currentValue}
        rows={isWelcome ? 2 : 1}
        disabled={disabled}
        onChange={(e) => setCurrentValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {streaming && onStop ? (
        <button
          type="button"
          className="composer-btn composer-btn--stop sp-icon-button sp-icon-button--lg sp-icon-button--accent"
          aria-label="Stop"
          onClick={onStop}
        >
          <StopOutlined />
        </button>
      ) : (
        <button
          type="button"
          className="composer-btn composer-btn--send sp-icon-button sp-icon-button--lg sp-icon-button--primary"
          aria-label="Send"
          disabled={disabled || !currentValue.trim()}
          onClick={handleSend}
        >
          <SendOutlined />
        </button>
      )}
    </div>
  );
}
