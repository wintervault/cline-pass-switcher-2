import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import enUS from './en-US.ts';
import zhCN from './zh-CN.ts';

/**
 * 多语言（3.0 P4）。
 *
 * 三条结构性约定：
 * 1. **中文词典是类型源头**：`zh-CN.ts` 导出 `as const` 的对象，英文词典的类型是
 *    `Record<keyof typeof zhCN, string>`——漏翻由 typecheck 拦住，不靠单测提醒；
 * 2. **即时热切换**：语言在 context 里，切换只触发重渲染，不刷新页面；
 *    同时切 antd 的 locale、dayjs 的 locale 与 `<html lang>`；
 * 3. **key 是稳定标识，不是文案**：`area.element`（`models.header.title`）。
 *    后端返回按 code 映射（见 codes.ts），前端不猜后端字符串。
 */
export type Lang = 'zh-CN' | 'en-US';

export type MsgKey = keyof typeof zhCN;

const DICTS: Record<Lang, Record<MsgKey, string>> = { 'zh-CN': zhCN, 'en-US': enUS };

/** 语言偏好存本地；首次进入按浏览器语言，中文用户默认中文。 */
const LANG_KEY = 'cps_lang';

export function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'zh-CN' || saved === 'en-US') return saved;
  return (navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}

export interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** 取词并插值：`t('models.deleteNote', { name })`。 */
  t: (key: MsgKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    dayjs.locale(lang === 'zh-CN' ? 'zh-cn' : 'en');
    localStorage.setItem(LANG_KEY, lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);

  const t = useMemo(() => {
    const dict = DICTS[lang];
    // 词典类型已保证 key 齐全；?? 只是防御运行时被外部篡改
    return (key: MsgKey, params?: Record<string, string | number>): string =>
      interpolate(dict[key] ?? zhCN[key], params);
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n 必须在 I18nProvider 内使用');
  return value;
}

/** 只要取词函数时的简写。 */
export function useT(): I18nValue['t'] {
  return useI18n().t;
}
