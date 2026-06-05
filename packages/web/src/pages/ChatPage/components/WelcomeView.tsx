import { useState } from "react";
import { ChatComposer } from "./ChatComposer";
import "./WelcomeView.css";

export function WelcomeView({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  return (
    <section className="welcome-view">
      <div className="welcome-inner">
        <img className="welcome-logo" src="/logo.png" alt="SunPilot logo" />
        <h1 className="welcome-title">你好，我是 SunPilot</h1>
        <p className="welcome-subtitle">
          一个由本地 daemon 驱动的业务 Agent 工作台。
        </p>

        <ChatComposer
          value={draft}
          onChange={setDraft}
          placeholder="向 SunPilot 提问..."
          variant="welcome"
          disabled={disabled}
          onSend={onSend}
        />
      </div>
    </section>
  );
}
