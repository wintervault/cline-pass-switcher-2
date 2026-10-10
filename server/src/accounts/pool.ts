import type { Account, AccountMode, Config } from '../config/schema.ts';

export interface AccountRotateInfo {
  from: string;
  to: string | null;
  reason: string;
}

/**
 * 账号池选择策略。
 *
 * 三种模式（sticky 为新默认）：
 * - `sticky`：持续用当前账号，**只有账号级错误才轮转**。这是为 prompt cache 设计的——
 *   agent 多轮对话每轮都带完整上下文，每请求轮转账号会让上游缓存全失效，成本按
 *   cache-miss 计价（可能贵一个数量级）。
 * - `single`：始终用 activeAccount 指定的账号。
 * - `roundrobin`：每次 pick 轮换（旧版行为，明确标注会牺牲 prompt cache）。
 *
 * 注意：传入的 Config 应是**运行时同一份对象引用**（JsonStore.value 就地更新），
 * 账号池才能感知控制台的账号变更，无需重建。
 */
export class AccountPool {
  #config: Config;
  /** sticky 模式的当前下标（指向启用账号列表）。 */
  #stickyIdx = 0;
  #rrCounter = 0;
  #rotateListeners: Array<(info: AccountRotateInfo) => void> = [];

  constructor(config: Config) {
    this.#config = config;
  }

  /** 启用中的账号（key 非空且未禁用）。 */
  enabled(): Account[] {
    return this.#config.accounts.filter((a) => a.key && a.enabled !== false);
  }

  /** 取一个账号；一次请求内应只调用一次并复用结果（保缓存）。 */
  pick(): Account | null {
    const list = this.enabled();
    if (!list.length) return null;

    const mode = this.#config.accountMode as AccountMode;
    if (mode === 'roundrobin' && list.length > 1) {
      const account = list[this.#rrCounter % list.length];
      this.#rrCounter = (this.#rrCounter + 1) % list.length;
      return account ?? null;
    }

    if (mode === 'single') {
      // activeAccount 是 config.accounts 全量列表的下标（与控制台 UI 的行号一致）；
      // 指向的账号被禁用时回退到第一个启用账号
      const byIdx = this.#config.accounts[this.#config.activeAccount];
      if (byIdx?.key && byIdx.enabled !== false) return byIdx;
      return list[0] ?? null;
    }

    // sticky
    const idx = Math.min(this.#stickyIdx, list.length - 1);
    return list[idx] ?? null;
  }

  /**
   * 账号级错误后轮转：换到 failed 之后的下一个启用账号。
   * 只有一个启用账号时无处可去，返回 null（调用方应直接把账号错误返回给客户端）。
   */
  rotate(failed: Account, reason: string): Account | null {
    const list = this.enabled();
    if (list.length <= 1) return null;

    const from = list.indexOf(failed);
    const next = list[(Math.max(from, 0) + 1) % list.length] ?? null;
    if (!next) return null;

    this.#stickyIdx = list.indexOf(next);
    const info: AccountRotateInfo = { from: failed.name, to: next.name, reason };
    for (const listener of this.#rotateListeners) listener(info);
    return next;
  }

  /** 订阅账号轮转事件（供日志与历史记录使用）。 */
  onRotate(listener: (info: AccountRotateInfo) => void): void {
    this.#rotateListeners.push(listener);
  }

  /** 供控制台展示：sticky 当前停在哪一个账号。 */
  stickyIndex(): number {
    return this.#stickyIdx;
  }
}
