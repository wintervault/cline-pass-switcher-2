import { describe, expect, it } from 'vitest';

import { StreamCollector } from '../src/proxy/collect.ts';

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const feed = (c: StreamCollector, chunks: string[]): void => {
  for (const chunk of chunks) c.push(chunk);
};
const done = 'data: [DONE]\n\n';

/** 取拼装结果的第一个 choice（没有就直接失败，避免测试里一堆可选链）。 */
function firstChoice(c: StreamCollector): Record<string, unknown> {
  const body = c.finish().body;
  if (!body) throw new Error('期望有 body');
  const choices = body['choices'] as Record<string, unknown>[];
  const choice = choices[0];
  if (!choice) throw new Error('期望至少一个 choice');
  return choice;
}

describe('StreamCollector：把 SSE 拼回非流式响应', () => {
  it('content 逐块拼接，usage 取末尾那块', () => {
    const c = new StreamCollector();
    feed(c, [
      data({
        id: 'g1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'x/y',
        provider: 'Xiaomi',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }],
      }),
      data({
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
        usage: { completion_tokens: 2 },
      }),
      done,
    ]);
    const out = c.finish();
    expect(out.error).toBeNull();
    const body = out.body as Record<string, unknown>;
    expect(body['id']).toBe('g1');
    expect(body['object']).toBe('chat.completion');
    expect(body['provider']).toBe('Xiaomi');
    expect(body['usage']).toEqual({ completion_tokens: 2 });
    const choice = (body['choices'] as Record<string, unknown>[])[0];
    expect(choice?.['message']).toEqual({ role: 'assistant', content: 'Hello' });
    expect(choice?.['finish_reason']).toBe('stop');
  });

  it('tool_calls 按 index 累积 name / arguments，正文为空时 content 为 null', () => {
    const c = new StreamCollector();
    feed(c, [
      data({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'read_', arguments: '{"pa' } },
              ],
            },
          },
        ],
      }),
      data({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      done,
    ]);
    const choice = firstChoice(c);
    expect(choice['message']).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    });
    expect(choice['finish_reason']).toBe('tool_calls');
  });

  it('reasoning 与 reasoning_details 都累积', () => {
    const c = new StreamCollector();
    feed(c, [
      data({
        choices: [
          {
            index: 0,
            delta: {
              reasoning: 'The user is',
              reasoning_details: [{ type: 'reasoning.text', text: 'The user is', index: 0 }],
            },
          },
        ],
      }),
      data({
        choices: [
          {
            index: 0,
            delta: { reasoning: ' asking', reasoning_details: [{ type: 'reasoning.text', text: ' asking', index: 0 }] },
            finish_reason: 'stop',
          },
        ],
      }),
      done,
    ]);
    const message = firstChoice(c)['message'] as Record<string, unknown>;
    expect(message['reasoning']).toBe('The user is asking');
    expect(message['reasoning_details']).toEqual([{ type: 'reasoning.text', index: 0, text: 'The user is asking' }]);
  });

  it('planner 的 provider_metadata 透传（钉住审计依赖它）', () => {
    const c = new StreamCollector();
    feed(c, [
      data({
        choices: [{ index: 0, delta: { content: 'ok' } }],
        provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } },
      }),
      done,
    ]);
    const body = c.finish().body as Record<string, unknown>;
    expect(body['provider_metadata']).toEqual({ gateway: { routing: { finalProvider: 'deepseek' } } });
  });

  it('一行被任意切分也能拼（真实网络的分块不可控）', () => {
    const c = new StreamCollector();
    c.push('data: {"choices":[{"index":0,"delta":{"con');
    c.push('tent":"hi"}}]}\n');
    c.push('\ndata: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    expect(firstChoice(c)['message']).toEqual({
      role: 'assistant',
      content: 'hi',
    });
  });

  it('忽略注释行与 event:/id: 字段', () => {
    const c = new StreamCollector();
    feed(c, [
      ': keep-alive\n\n',
      'event: message\nid: 7\n',
      data({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      done,
    ]);
    expect(c.finish().error).toBeNull();
  });

  it('流内错误对象 → error（交给链去分类与切换）', () => {
    const c = new StreamCollector();
    feed(c, [data({ error: 'rate limited by shared pool' }), done]);
    const out = c.finish();
    expect(out.body).toBeNull();
    expect(out.error).toBe('rate limited by shared pool');
  });

  it('没有 [DONE] 也没有 finish_reason = 被截断，不能当成功', () => {
    const c = new StreamCollector();
    feed(c, [data({ choices: [{ index: 0, delta: { content: 'partial' } }] })]);
    const out = c.finish();
    expect(out.body).toBeNull();
    expect(out.error).toBe('stream ended unexpectedly');
  });

  it('多 choice 各自拼装，按 index 排序', () => {
    const c = new StreamCollector();
    feed(c, [
      data({
        choices: [
          { index: 1, delta: { content: 'B' } },
          { index: 0, delta: { content: 'A' } },
        ],
      }),
      data({
        choices: [
          { index: 0, finish_reason: 'stop' },
          { index: 1, finish_reason: 'stop' },
        ],
      }),
      done,
    ]);
    const body = c.finish().body;
    if (!body) throw new Error('期望有 body');
    const choices = body['choices'] as Record<string, unknown>[];
    expect(choices.map((x) => (x['message'] as Record<string, unknown>)['content'])).toEqual(['A', 'B']);
  });
});
