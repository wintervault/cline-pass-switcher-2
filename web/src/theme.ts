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
 * 品牌与部件级 token 覆盖：亮暗共用一套语义——主色只用于主操作 / 选中 / 状态，
 * 层次交给 antd 算法，保证两个主题下观感一致。页面标题排版在此统一收口。
 */
const sharedToken = {
  colorPrimary: '#4f8cff',
  colorInfo: '#4f8cff',
  borderRadius: 6,
  fontSizeHeading3: 20,
};

/** 部件级微调：表头去掉列分隔灰线（按行分隔足够，视觉更干净）。 */
const sharedComponents = {
  Table: { headerSplitColor: 'transparent' },
};

export const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: sharedToken,
  components: sharedComponents,
};

export const lightTheme = {
  algorithm: theme.defaultAlgorithm,
  token: sharedToken,
  components: sharedComponents,
};
