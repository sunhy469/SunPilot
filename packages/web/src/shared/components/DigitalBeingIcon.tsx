import "./DigitalBeingIcon.scss";

/**
 * 数字生命 — 动态机器人头像图标
 *
 * 效果：
 * - 方形机器人头部，圆角
 * - 扫描线从上到下扫过
 * - 天线微动
 * - 眼睛发光闪烁
 */
export function DigitalBeingIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="1 0 17 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`digital-being-icon${className ? ` ${className}` : ""}`}
    >
      {/* ═══ 天线 ═══ */}
      <line
        x1="9.5"
        y1="3"
        x2="9.5"
        y2="5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        className="antenna"
      />
      <circle cx="9.5" cy="2.5" r="1" fill="currentColor" className="antenna-dot" />

      {/* ═══ 方形机器人头部 ═══ */}
      <rect
        x="5"
        y="5.5"
        width="9"
        height="9"
        rx="2"
        ry="2"
        stroke="currentColor"
        strokeWidth="1.5"
        className="head-outline"
      />

      {/* ═══ 机器人眼睛（方形发光） ═══ */}
      <rect
        x="7"
        y="8"
        width="2"
        height="1.8"
        rx="0.5"
        fill="currentColor"
        className="eye eye-left"
      />
      <rect
        x="10"
        y="8"
        width="2"
        height="1.8"
        rx="0.5"
        fill="currentColor"
        className="eye eye-right"
      />

      {/* ═══ 嘴巴（机器人格栅） ═══ */}
      <line
        x1="7.5"
        y1="12"
        x2="11.5"
        y2="12"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinecap="round"
        className="mouth mouth-1"
      />
      <line
        x1="8"
        y1="13"
        x2="11"
        y2="13"
        stroke="currentColor"
        strokeWidth="0.7"
        strokeLinecap="round"
        className="mouth mouth-2"
      />

      {/* ═══ 耳朵 / 侧边模块 ═══ */}
      <rect
        x="3.5"
        y="8"
        width="1.5"
        height="3"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1"
        className="ear ear-left"
      />
      <rect
        x="14"
        y="8"
        width="1.5"
        height="3"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1"
        className="ear ear-right"
      />

      {/* ═══ 扫描线 + 辉光拖尾（clip 到头部内部） ═══ */}
      <clipPath id="head-clip">
        <rect x="5" y="5.5" width="9" height="9" rx="2" />
      </clipPath>
      <g clipPath="url(#head-clip)">
        <line
          x1="4.5"
          y1="5.5"
          x2="14.5"
          y2="5.5"
          stroke="currentColor"
          strokeWidth="0.7"
          strokeLinecap="round"
          className="scan-line"
        />
        <line
          x1="4.5"
          y1="5.5"
          x2="14.5"
          y2="5.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="scan-line-glow"
        />
      </g>

      {/* ═══ 电路节点 ═══ */}
      <circle cx="4" cy="9.5" r="0.6" fill="currentColor" className="node node-nw" />
      <circle cx="15" cy="9.5" r="0.6" fill="currentColor" className="node node-ne" />
      <circle cx="4.5" cy="5" r="0.5" fill="currentColor" className="node node-nw-top" />
      <circle cx="14.5" cy="5" r="0.5" fill="currentColor" className="node node-ne-top" />
      <circle cx="5" cy="15.5" r="0.5" fill="currentColor" className="node node-sw" />
      <circle cx="14" cy="15.5" r="0.5" fill="currentColor" className="node node-se" />
    </svg>
  );
}
