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

/** 共享品牌色等 token 覆盖：亮暗共用，只有算法不同。 */
const sharedToken = {
  colorPrimary: '#4f8cff',
  borderRadius: 6,
};

export const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: sharedToken,
};

export const lightTheme = {
  algorithm: theme.defaultAlgorithm,
  token: sharedToken,
};
