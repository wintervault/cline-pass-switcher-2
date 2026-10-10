import { AccountPool } from '../../src/accounts/pool.ts';
import type { PerModelConfig } from '../../src/config/schema.ts';
import { defaultConfig } from '../../src/config/schema.ts';
import { ChatChain } from '../../src/proxy/chain.ts';
import { ChannelHealth } from '../../src/proxy/health.ts';
import type { ModelMeta } from '../../src/upstream/types.ts';
import { FakeUpstream } from './upstream.ts';

export interface StreamFixture {
  upstream: FakeUpstream;
  chain: ChatChain;
  metaOf: (over?: Partial<ModelMeta>) => ModelMeta;
  cfgOf: (over?: Partial<PerModelConfig>) => PerModelConfig;
  close: () => Promise<void>;
}

/** 起一个假上游 + 装配好的流式 ChatChain，测试结束记得 close()。 */
export async function chainStream(): Promise<StreamFixture> {
  const upstream = new FakeUpstream();
  const base = await upstream.listen();
  const config = defaultConfig();
  config.accounts = [
    { name: 'A', key: 'sk_a', enabled: true },
    { name: 'B', key: 'sk_b', enabled: true },
  ];
  const chain = new ChatChain({
    upstreamBase: base,
    failover: config.failover,
    pool: new AccountPool(config),
    health: new ChannelHealth(),
  });
  const metaOf = (over: Partial<ModelMeta> = {}): ModelMeta => ({
    pipeline: 'planner',
    pinnable: true,
    availableProviders: [],
    upstreams: ['ch1', 'ch2'],
    upstreamDetail: {},
    upstreamStatus: {},
    tier0: [],
    canonicalSlug: null,
    openrouterSlug: null,
    lastProvider: null,
    lastMs: null,
    probedAt: null,
    validatedAt: null,
    ...over,
  });
  const cfgOf = (over: Partial<PerModelConfig> = {}): PerModelConfig => ({
    upstreams: ['ch1', 'ch2'],
    exclude: [],
    pinMode: 'strict',
    sort: null,
    ...over,
  });
  return { upstream, chain, metaOf, cfgOf, close: () => upstream.close() };
}

/**
 * 读取链路返回的上游流剩余部分。
 * 链路已用 getReader() 消费过首块，body 处于「已读」状态，response.text() 会抛
 * "Body is unusable"（fetch 规范行为），必须继续用 reader 读。
 */
export async function readRest(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Buffer[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已取消 */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}
