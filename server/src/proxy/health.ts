/** 渠道冷却状态（运行时，不持久化）。渠道级失败后进入冷却窗口。 */
export class ChannelHealth {
  /** key: `${modelId}\u0000${upstream}` → 冷却截止时间戳。 */
  readonly #cooling = new Map<string, number>();

  static #key(modelId: string, upstream: string): string {
    return `${modelId}\u0000${upstream}`;
  }

  markFailed(modelId: string, upstream: string, cooldownMs: number): void {
    if (cooldownMs <= 0 || !upstream) return;
    this.#cooling.set(ChannelHealth.#key(modelId, upstream), Date.now() + cooldownMs);
  }

  /** 成功时立即解除冷却（渠道恢复了）。 */
  markSuccess(modelId: string, upstream: string): void {
    if (!upstream) return;
    this.#cooling.delete(ChannelHealth.#key(modelId, upstream));
  }

  isCooling(modelId: string, upstream: string, now = Date.now()): boolean {
    const until = this.#cooling.get(ChannelHealth.#key(modelId, upstream));
    if (until === undefined) return false;
    if (until <= now) {
      this.#cooling.delete(ChannelHealth.#key(modelId, upstream));
      return false;
    }
    return true;
  }

  /** 剩余冷却毫秒数；未冷却返回 0。 */
  remainingMs(modelId: string, upstream: string, now = Date.now()): number {
    const until = this.#cooling.get(ChannelHealth.#key(modelId, upstream));
    if (until === undefined) return 0;
    return Math.max(0, until - now);
  }

  size(): number {
    return this.#cooling.size;
  }
}
