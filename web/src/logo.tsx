/**
 * 应用标识（内联 SVG）：与桌面壳 / 安装包图标同源的设计
 * （见 scripts/generate-icon.mjs —— 「一路输入、三路候选、钉住高亮」的路由隐喻）。
 * 中间渠道即钉住目标：青色端点 + 光环；上下两条为暗一档的候选。
 */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="cps-logo-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6AA5FF" />
          <stop offset="1" stopColor="#2E5BEB" />
        </linearGradient>
        <radialGradient id="cps-logo-hl" cx="118" cy="72" r="360" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx="115" fill="url(#cps-logo-bg)" />
      <rect width="512" height="512" rx="115" fill="url(#cps-logo-hl)" />
      <rect x="2" y="2" width="508" height="508" rx="113" stroke="#fff" strokeOpacity="0.14" strokeWidth="4" />
      {/* 候选渠道（暗一档） */}
      <path
        d="M206 256 V202 A40 40 0 0 1 246 162 H372"
        stroke="#fff"
        strokeOpacity="0.55"
        strokeWidth="34"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M206 256 V310 A40 40 0 0 0 246 350 H372"
        stroke="#fff"
        strokeOpacity="0.55"
        strokeWidth="34"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="382" cy="162" r="24" fill="#fff" fillOpacity="0.55" />
      <circle cx="382" cy="350" r="24" fill="#fff" fillOpacity="0.55" />
      {/* 主干 + 钉住目标（高亮端点 + 光环） */}
      <path d="M110 256 H368" stroke="#fff" strokeWidth="34" strokeLinecap="round" />
      <circle cx="382" cy="256" r="48" stroke="#fff" strokeOpacity="0.22" strokeWidth="12" />
      <circle cx="382" cy="256" r="32" fill="#7DE9FF" />
      {/* 入口 */}
      <circle cx="110" cy="256" r="30" fill="#fff" />
    </svg>
  );
}
