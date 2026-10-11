import { App } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';

/**
 * 统一的动作回执（气泡提醒）。
 *
 * 起因：功能做完不给任何反馈，用户不知道「到底成了没有」——重启完没反应、
 * 探测完没反应、保存了也不确定。这里把「反馈」收敛成一处，保证：
 *
 * - **每一类结果都有固定的语义与停留时长**：成功短（2.5s，用户只需要确认）、
 *   失败长（6s，要留出读原因的时间）、纯提示 3s。
 * - **长耗时操作必须有「进行中」态**：探测/校验要跑好几秒，只给成功提示的话
 *   那几秒里用户完全不知道自己在等什么。`busy()` 返回结束函数，天然保证
 *   进行中提示一定会被收掉（不会留一个转圈的幽灵提示）。
 * - **失败必带原因**：只显示「失败」等于没提示。`fail()` 统一把 Error/字符串
 *   里的可读信息提出来。
 */

const OK_MS = 2.5;
const FAIL_MS = 6;
const INFO_MS = 3;

function reasonOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return '未知错误';
}

export interface Feedback {
  ok: (text: string) => void;
  fail: (text: string, err?: unknown) => void;
  info: (text: string) => void;
  /**
   * 长任务：先弹「进行中」，返回的函数用结果收尾。
   * 用法：`const done = fb.busy('正在探测…'); ... done.ok('探测完成：19 个渠道')`
   */
  busy: (text: string) => {
    ok: (text: string) => void;
    fail: (text: string, err?: unknown) => void;
  };
  copy: (what?: string) => void;
}

/** 把 antd 的 message 实例包成本项目的反馈口径。 */
export function makeFeedback(message: MessageInstance): Feedback {
  const ok = (text: string): void => void message.success({ content: text, duration: OK_MS });
  const info = (text: string): void => void message.info({ content: text, duration: INFO_MS });
  const fail = (text: string, err?: unknown): void => {
    const detail = err === undefined ? '' : reasonOf(err);
    const content = detail && !text.includes(detail) ? `${text}：${detail}` : text;
    void message.error({ content, duration: FAIL_MS });
  };
  return {
    ok,
    info,
    fail,
    busy: (text: string) => {
      // 只关自己这一条：destroy() 会连用户正在读的报错一起关掉
      const closeSelf = message.open({ type: 'loading', content: text, duration: 0 }) as unknown as () => void;
      return {
        ok: (t: string) => {
          closeSelf();
          ok(t);
        },
        fail: (t: string, err?: unknown) => {
          closeSelf();
          fail(t, err);
        },
      };
    },
    copy: (what = '内容') => ok(`${what}已复制到剪贴板`),
  };
}

/** 组件内取反馈器。必须在 `<App>`（antd）内部调用，才能拿到主题化的实例。 */
export function useFeedback(): Feedback {
  const { message } = App.useApp();
  return makeFeedback(message);
}
