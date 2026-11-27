import { useId } from "react";
import type { InstallTask } from "../installContext";

const PIE_RADIUS = 15.25;
const PIE_STROKE = PIE_RADIUS * 2; // 30.5 -> 完整覆盖半径 30.5 的圆盘
const PIE_CIRCUMFERENCE = 2 * Math.PI * PIE_RADIUS;

export function installPhaseLabel(task: InstallTask): string {
  switch (task.phase) {
    case "queued":
      return "等待中…";
    case "uploading":
      if (task.uploadFraction !== undefined && task.uploadFraction > 0 && task.uploadFraction < 1) {
        return `上传 ${Math.round(task.uploadFraction * 100)}%`;
      }
      return "上传中…";
    case "building":
      return "构建中…";
    case "installing":
      return task.isUpgrade ? "更新中…" : "安装中…";
    case "confirm-privileges":
      return "待确认…";
    case "completing":
      return task.name;
  }
}

// 仿 iOS 主屏幕应用安装动效：暗色半透明遮罩覆盖圆角图标，中央镂空圆环，
// 随进度顺时针扇形擦除遮罩露出原图标；完成时圆洞向外扩散退场。
export default function IosInstallOverlay({ task }: { task: InstallTask }) {
  const maskId = useId();
  const clamped = Math.max(0, Math.min(1, task.progress));
  const completing = task.phase === "completing";
  const waiting = task.phase === "queued" || task.phase === "confirm-privileges";
  const dashOffset = PIE_CIRCUMFERENCE * (1 - (completing ? 1 : clamped));

  return (
    <span
      className={`vb-ios-overlay${completing ? " is-completing" : ""}${waiting ? " is-waiting" : ""}`}
      aria-hidden="true"
    >
      <svg className="vb-ios-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        <defs>
          <mask id={maskId}>
            <rect x="0" y="0" width="100" height="100" fill="white" />
            {/* 外圈细环镂空，透出底层图标，还原 iOS 经典的表盘环缝 */}
            <circle cx="50" cy="50" r="35" fill="none" stroke="black" strokeWidth="3.2" />
            {/* 顺时针扇形进度：黑色部分挖空暗色遮罩，逐步露出清晰图标 */}
            <circle
              className="vb-ios-pie"
              cx="50"
              cy="50"
              r={PIE_RADIUS}
              fill="none"
              stroke="black"
              strokeWidth={PIE_STROKE}
              strokeDasharray={PIE_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 50 50)"
            />
            {/* 安装完成时圆孔快速向外扩张，抹去四角暗色遮罩 */}
            <circle
              className={completing ? "vb-ios-reveal is-completing" : "vb-ios-reveal"}
              cx="50"
              cy="50"
              r="30.6"
              fill="black"
            />
          </mask>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="rgba(0, 0, 0, 0.54)" mask={`url(#${maskId})`} />
        {!completing && (
          <circle
            className="vb-ios-ring"
            cx="50"
            cy="50"
            r="35"
            fill="none"
            stroke="rgba(255, 255, 255, 0.45)"
            strokeWidth="2.2"
          />
        )}
        {waiting && (
          <circle
            className="vb-ios-waiting-arc"
            cx="50"
            cy="50"
            r="35"
            fill="none"
            stroke="rgba(255, 255, 255, 0.9)"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeDasharray="48 172"
          />
        )}
      </svg>
    </span>
  );
}
