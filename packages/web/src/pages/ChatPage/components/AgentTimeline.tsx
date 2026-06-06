import type { AgentTimelineItem } from "../hooks/useChat";
import "./AgentTimeline.css";

export function AgentTimeline({ items }: { items: AgentTimelineItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="agent-timeline" aria-label="Agent timeline">
      {items.map((item) => (
        <div className={`agent-timeline__item is-${item.tone}`} key={item.id}>
          <span className="agent-timeline__dot" aria-hidden="true" />
          <div className="agent-timeline__body">
            <div className="agent-timeline__title">{item.title}</div>
            {item.detail && (
              <div className="agent-timeline__detail">{item.detail}</div>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
