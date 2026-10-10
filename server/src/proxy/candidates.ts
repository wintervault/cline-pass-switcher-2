import type { PerModelConfig } from '../config/schema.ts';
import type { SortKey } from '../upstream/routing.ts';

/**
 * 候选渠道的冷却状态查询。由 ChatChain 持有的运行时健康表实现，
 * 这里只依赖这一个方法，保持候选生成可独立测试。
 */
export interface CoolingCheck {
  isCooling(modelId: string, upstream: string): boolean;
}

export interface CandidatePlan {
  /** 候选渠道序列（冷却的沉底）；空数组 = 自动模式（单次尝试，交给网关）。 */
  channels: readonly string[];
  pinMode: 'strict' | 'preferred';
  sort: SortKey | null;
  /** 用户配置的排除列表。 */
  excludeList: readonly string[];
  /** true = 排除无法生效：本地没有渠道清单（未探测过）或已知渠道全被排除。 */
  degraded: boolean;
  notes: readonly string[];
}

export interface BuildCandidatesInput {
  modelId: string;
  cfg?: PerModelConfig;
  meta?: { upstreams?: readonly string[] };
  health: CoolingCheck;
}

/**
 * 生成故障转移的候选渠道序列（纯函数）。
 *
 * 顺序规则（用户确认的设计）：
 * 1. 用户勾选的顺序是首要依据——显式配置的优先级不该被运行时状态悄悄改写；
 * 2. **冷却中的渠道沉底**（不剔除，全部冷却则保持原顺序）。这一条就覆盖了
 *    「上次失败这次别先试它」的需求：失败渠道进冷却 → 后续请求直接从健康渠道开始，
 *    既少一次注定失败的尝试，也保住了健康渠道上的 prompt cache；
 * 3. 自动模式（没勾选任何渠道）不做候选排序——渠道由网关挑，本地只注入排除白名单。
 *
 * preferred 模式的语义（用户确认：「本地说了算」）在链路层展开：
 * 前面的候选全部 strict（只钉当前渠道），只给**最后一个候选**放开网关回退。
 */
export function buildCandidates(input: BuildCandidatesInput): CandidatePlan {
  const { modelId, cfg, meta, health } = input;

  const listed = (cfg?.upstreams ?? []).filter((u) => typeof u === 'string' && u);
  const exclude = (cfg?.exclude ?? []).filter((u) => typeof u === 'string' && u);
  const excl = new Set(exclude);
  const wanted = listed.filter((u) => !excl.has(u));
  const sort = cfg?.sort ?? null;
  const pinMode = cfg?.pinMode === 'preferred' ? 'preferred' : 'strict';
  const known = meta?.upstreams ?? [];
  const notes: string[] = [];

  // 排除依赖「已知渠道清单」换算成 only 白名单（网关不支持 exclude 字段，实测被忽略）
  const degraded = exclude.length > 0 && (known.length === 0 || known.every((u) => excl.has(u)));
  if (degraded) {
    notes.push('排除列表无法生效：本地没有该模型的渠道清单（先点「探测」），或已知渠道全部被排除');
  }

  const fresh: string[] = [];
  const cooling: string[] = [];
  for (const c of wanted) (health.isCooling(modelId, c) ? cooling : fresh).push(c);

  return {
    channels: [...fresh, ...cooling],
    pinMode,
    sort,
    excludeList: exclude,
    degraded,
    notes,
  };
}
