import {
  FileTextOutlined,
  BarChartOutlined,
  BulbOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import { EmptyStateIllustration } from "../../../shared/components/illustrations";
import { ChatComposer } from "./ChatComposer";
import { QuickActionCard } from "./QuickActionCard";
import "./WelcomeView.css";

const quickActions = [
  {
    key: "analyze",
    title: "分析项目",
    desc: "深入分析项目结构与代码质量",
    icon: <FileTextOutlined />,
    tone: "blue" as const,
    prompt: "请帮我分析这个项目的整体架构，并指出可以优化的地方。",
  },
  {
    key: "report",
    title: "生成报表",
    desc: "根据数据生成可视化报表与洞察",
    icon: <BarChartOutlined />,
    tone: "green" as const,
    prompt: "请根据当前数据生成一份结构清晰的分析报表。",
  },
  {
    key: "solve",
    title: "解决问题",
    desc: "排查问题并提供解决方案",
    icon: <BulbOutlined />,
    tone: "purple" as const,
    prompt: "请帮我排查当前问题，并给出逐步解决方案。",
  },
];

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
        <EmptyStateIllustration type="chat" className="welcome-illustration" />
        <h1 className="welcome-title">你好，我是 SunPilot</h1>
        <p className="welcome-subtitle">
          可以帮你分析项目、整理知识、生成报告和推进任务。
        </p>

        <ChatComposer
          value={draft}
          onChange={setDraft}
          placeholder="向 SunPilot 提问..."
          variant="welcome"
          disabled={disabled}
          onSend={onSend}
        />

        <div className="quick-cards">
          {quickActions.map((item) => (
            <QuickActionCard
              key={item.key}
              title={item.title}
              desc={item.desc}
              icon={item.icon}
              tone={item.tone}
              onClick={() => setDraft(item.prompt)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
