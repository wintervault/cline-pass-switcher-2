/**
 * 账号的**观测值**类型（不是配置）。
 *
 * 风控分类是「我们向网关发一次请求看到的事实」，会随时间翻转——所以它存
 * metadata（可重建的观测数据），不存 config（用户声明）。这一区分是 3.0 的
 * 结构性决定（docs/ROADMAP-3.0.md §9 第 11 条）。
 */

/**
 * 风控分类：
 * - `normal`：默认路由落在真实渠道（如 deepseek）
 * - `private`：默认路由恒为 `openai-compatible-private`（网关风控号）
 * - `unknown`：没体检过，或最近一次体检没能得出结论（不猜）
 */
export type AccountClassKind = 'normal' | 'private' | 'unknown';

export interface AccountClassRecord {
  class: AccountClassKind;
  /** 得出这个结论的时间；`unknown` 且从未成功过时为 null。 */
  checkedAt: number | null;
  /** 最近一次体检的失败原因（成功时缺省）。不覆盖已有结论，只作解释。 */
  note?: string;
}
