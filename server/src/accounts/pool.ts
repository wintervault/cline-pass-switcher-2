import type { Account, AccountMode } from '../config/schema.ts';

export interface AccountRotateInfo {
  from: string;
  to: string | null;
  reason: string;
}

/**
 * 账号池看到的那一部分配置。
 *
 * 3.0 起账号池是**按网关**的：每个网关一个实例（各自的粘性位置与轮转计数），
 * 但账号本身是全局的——这里拿到的是「该网关可见的账号子集」。
 * 用取值函数注入（而不是传一份快照），配置在控制台里就地改动后立即生效。
 */
export interface AccountPoolView {
  accounts: readonly Account[];
  accountMode: AccountMode;
  /** single 模式使用的账号名（账号标识是 name）；空 = 第一个启用账号。 */
  activeAccount: string;
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
 */
export class AccountPool {
  readonly #view: () => AccountPoolView;
  /** sticky 模式的当前下标（指向启用账号列表）。 */
  #stickyIdx = 0;
  #rrCounter = 0;
  #rotateListeners: Array<(info: AccountRotateInfo) => void> = [];

  constructor(view: () => AccountPoolView) {
    this.#view = view;
  }

  /** 启用中的账号（key 非空且未禁用）。 */
  enabled(): Account[] {
    return this.#view().accounts.filter((a) => a.key && a.enabled !== false);
  }

  /** 取一个账号；一次请求内应只调用一次并复用结果（保缓存）。 */
  pick(): Account | null {
    const list = this.enabled();
    if (!list.length) return null;

    const view = this.#view();
    if (view.accountMode === 'roundrobin' && list.length > 1) {
      const account = list[this.#rrCounter % list.length];
      this.#rrCounter = (this.#rrCounter + 1) % list.length;
      return account ?? null;
    }

    if (view.accountMode === 'single') {
      const named = view.activeAccount ? list.find((a) => a.name === view.activeAccount) : undefined;
      return named ?? list[0] ?? null;
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
