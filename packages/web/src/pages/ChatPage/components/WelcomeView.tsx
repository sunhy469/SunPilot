import { useState } from "react";
import { Typography } from "antd";
import { ChatComposer } from "./ChatComposer";
import type { AttachmentRef } from "../../../features/chat/types";
import "./WelcomeView.css";

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
    <div className="welcome-view">
      <div className="welcome-inner">
        <Title level={2} className="welcome-title">
          你好，我是 SunPilot
        </Title>
        <Text className="welcome-desc">
          上传商品图、参考视频或货源链接，我可以帮你生成图文、视频脚本和分析方案。
        </Text>

        <ChatComposer
          value={draft}
          onChange={setDraft}
          placeholder="向 SunPilot 提问..."
          variant="default"
          disabled={disabled}
          onSend={onSend}
        />
      </div>
    </div>
  );
}
