import { useState } from "react";
import { Typography } from "antd";
import { ChatComposer } from "./ChatComposer";
import "./WelcomeView.css";

const { Title } = Typography;

export function WelcomeView({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  return (
    <div className="welcome-view">
      <div className="welcome-inner">
        <Title level={2}>你好，我是 SunPilot，有什么可以帮到您？</Title>

        <ChatComposer
          value={draft}
          onChange={setDraft}
          placeholder="向 SunPilot 提问..."
          variant="welcome"
          disabled={disabled}
          onSend={onSend}
        />
      </div>
    </div>
  );
}
