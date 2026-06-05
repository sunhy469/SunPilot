import type { ReactNode } from "react";
import "./QuickActionCard.css";

export function QuickActionCard({
  title,
  desc,
  icon,
  tone,
  onClick,
}: {
  title: string;
  desc: string;
  icon: ReactNode;
  tone: "blue" | "green" | "purple";
  onClick: () => void;
}) {
  return (
    <button type="button" className={`quick-card quick-card--${tone}`} onClick={onClick}>
      <div className={`quick-card-icon icon-${tone}`}>{icon}</div>
      <div className="quick-card-title">{title}</div>
      <div className="quick-card-desc">{desc}</div>
    </button>
  );
}
