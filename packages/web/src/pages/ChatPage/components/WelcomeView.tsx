import { useState } from "react";
import { Typography, Image } from "antd";
import { ChatComposer } from "./ChatComposer";
import "./WelcomeView.css";

const { Title, Paragraph } = Typography;

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
        <Image className="welcome-logo" src="/logo.png" alt="SunPilot logo" preview={false} />
        <Title level={2}>你好，我是 SunPilot</Title>
        <Paragraph type="secondary">
          一个由本地 daemon 驱动的业务 Agent 工作台。
        </Paragraph>

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
