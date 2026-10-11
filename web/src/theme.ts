import { theme } from 'antd';

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE = 'cps_theme';

/** 初始主题：localStorage 优先，否则跟随系统。 */
export function initialTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_STORAGE);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function persistTheme(mode: ThemeMode): void {
  localStorage.setItem(THEME_STORAGE, mode);
}

/**
 * 品牌与体系 token（亮暗共用语义）。排版角色固定四层：
 * 20 页标题 / 14 正文与控件 / 13 说明文字 / 12 小注与数据。
 * 主色只用于主操作、选中与状态，其余交给 antd 算法。
 */
const sharedToken = {
  colorPrimary: '#4f8cff',
  colorInfo: '#4f8cff',
  borderRadius: 6,
  fontSizeHeading3: 20,
};

/**
 * 暗色专用：antd 默认纯黑布局底（#000）在桌面应用里过于生硬。
 * 抬升为三层体系——布局底 / 容器面 / 弹层，层次靠亮度差与极淡描边，
 * 而不是靠高对比边框。
 */
const darkToken = {
  ...sharedToken,
  colorBgLayout: '#0e0f12',
  colorBgContainer: '#16181d',
  colorBgElevated: '#1e2026',
  colorBorderSecondary: '#25272e',
};

/** 部件级微调：表头去掉列分隔灰线（按行分隔足够，视觉更干净）。 */
const sharedComponents = {
  Table: { headerSplitColor: 'transparent' },
};

export const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: darkToken,
  components: sharedComponents,
};

export const lightTheme = {
  algorithm: theme.defaultAlgorithm,
  token: sharedToken,
  components: sharedComponents,
};
