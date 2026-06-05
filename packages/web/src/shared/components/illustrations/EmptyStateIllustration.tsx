import "./EmptyStateIllustration.css";

export type EmptyStateIllustrationType =
  | "chat"
  | "project"
  | "knowledge"
  | "memory"
  | "report"
  | "error";

const copy: Record<EmptyStateIllustrationType, { title: string; accent: string }> = {
  chat: { title: "AI workspace", accent: "#2563eb" },
  project: { title: "Project analysis", accent: "#06b6d4" },
  knowledge: { title: "Knowledge base", accent: "#8b5cf6" },
  memory: { title: "Memory graph", accent: "#10b981" },
  report: { title: "Report builder", accent: "#f59e0b" },
  error: { title: "Error state", accent: "#ef4444" },
};

export function EmptyStateIllustration({
  type = "chat",
  className = "",
}: {
  type?: EmptyStateIllustrationType;
  className?: string;
}) {
  const item = copy[type];

  return (
    <svg
      className={`empty-illustration ${className}`.trim()}
      viewBox="0 0 420 260"
      role="img"
      aria-label={item.title}
    >
      <defs>
        <linearGradient id={`sunpilot-soft-${type}`} x1="68" x2="318" y1="34" y2="228">
          <stop stopColor="#eff6ff" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
      </defs>
      <path
        d="M78 216c-34-22-46-64-28-98 18-35 65-38 92-60 31-26 48-54 93-45 44 9 45 55 77 78 30 22 67 28 74 65 8 41-26 76-70 86-42 10-74-10-114-10-49 0-83 11-124-16Z"
        fill={`url(#sunpilot-soft-${type})`}
      />
      <circle cx="317" cy="52" r="18" fill="#facc15" opacity="0.95" />
      <circle cx="90" cy="80" r="9" fill="#dbeafe" />
      <circle cx="350" cy="185" r="7" fill="#fef3c7" />
      <rect x="103" y="70" width="206" height="126" rx="22" fill="#fff" stroke="#dbe3ef" />
      <rect x="126" y="93" width="78" height="12" rx="6" fill="#dbeafe" />
      <rect x="126" y="119" width="130" height="10" rx="5" fill="#eef2f7" />
      <rect x="126" y="139" width="96" height="10" rx="5" fill="#eef2f7" />
      <rect x="126" y="160" width="58" height="16" rx="8" fill={item.accent} opacity="0.9" />
      <path
        d="M260 118c18 0 32 14 32 32s-14 32-32 32-32-14-32-32 14-32 32-32Z"
        fill="#eff6ff"
      />
      <path
        d="M246 150c7-13 21-13 28 0m-21-9h.1m15 0h.1"
        fill="none"
        stroke={item.accent}
        strokeLinecap="round"
        strokeWidth="5"
      />
      <path d="M84 211h254" stroke="#dbe3ef" strokeLinecap="round" strokeWidth="8" />
      <path
        d="M72 178c20-6 32-20 36-42 15 18 17 39 6 64-12 0-26-7-42-22Z"
        fill="#d1fae5"
      />
      <path
        d="M330 118c18 8 29 23 34 45-18-1-33-10-47-26 4-7 8-13 13-19Z"
        fill="#ede9fe"
      />
    </svg>
  );
}
