import { useState } from "react";
import { Typography, Flex } from "antd";
import { ChatComposer } from "../ChatComposer/ChatComposer";
import type { AttachmentRef } from "../../../../features/chat/types";
import "./WelcomeView.scss";

const { Title, Text } = Typography;

export function WelcomeView({
  onSend,
  disabled,
}: {
  onSend: (text: string, attachments?: AttachmentRef[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  return (
    <Flex align="center" justify="center" className="welcome-view">
      <Flex vertical align="center" className="welcome-inner">
        <Title level={2} className="welcome-title">
          你好，我是 SunPilot
        </Title>

        <ChatComposer
          value={draft}
          onChange={setDraft}
          placeholder="向 SunPilot 提问..."
          variant="welcome"
          disabled={disabled}
          onSend={onSend}
        />
      </Flex>
    </Flex>
  );
}
