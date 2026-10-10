import { describe, expect, it } from 'vitest';

import { classifyChannelStatus, classifyErrorKind } from '../src/upstream/errors.ts';
import { unwrap } from '../src/upstream/response.ts';

// ---------- 故障转移三分类 ----------

describe('classifyErrorKind', () => {
  it('网络失败 / 超时（无状态码）→ 渠道级', () => {
    expect(classifyErrorKind({ status: null, message: '' })).toBe('channel');
    expect(classifyErrorKind({ status: null, message: 'fetch failed' })).toBe('channel');
  });

  it.each([401, 402, 403])('HTTP %i → 账号级', (status) => {
    expect(classifyErrorKind({ status, message: 'denied' })).toBe('account');
  });

  it.each([
    'Unauthorized',
    'Please re-authenticate your account',
    'invalid api key provided',
    'Insufficient credits, please top up',
    'You exceeded your current quota',
    'billing issue detected',
  ])('错误文本 %s → 账号级（换渠道无效）', (message) => {
    // 状态码给 200：网关会把账号错误包在 200 响应体里，文本检测必须先于状态码
    expect(classifyErrorKind({ status: 200, message })).toBe('account');
  });

  it('状态码 401/402/403 即便无文本也是账号级', () => {
    expect(classifyErrorKind({ status: 401, message: '' })).toBe('account');
  });

  it.each([429, 500, 502, 503, 504])('HTTP %i → 渠道级', (status) => {
    expect(classifyErrorKind({ status, message: 'oops' })).toBe('channel');
  });

  it.each([
    'Rate limit exceeded, please retry',
    'temporarily rate limited by shared pool',
    'provider overloaded',
    'no allowed providers for this model',
    'no available providers',
    'Available providers are: alibaba, baseten. ',
    'Failed to resolve modelid for channel',
    'Request timed out after 30s',
  ])('渠道故障文本 %s → 渠道级', (message) => {
    // 状态码给 400：若文本检测失效会落到「请求级」，测试才有区分度
    expect(classifyErrorKind({ status: 400, message })).toBe('channel');
  });

  it('限流文本里捎带配额字样 → 仍是渠道级（限流语言辨识度更高）', () => {
    expect(classifyErrorKind({ status: 429, message: 'Rate limit exceeded: free-models-per-day quota' })).toBe(
      'channel',
    );
  });

  it('429 出现在错误文本里（网关可能 200 包错误体）→ 渠道级', () => {
    expect(classifyErrorKind({ status: 200, message: 'upstream returned 429 too many requests' })).toBe('channel');
  });

  it.each([
    ['invalid JSON in request body', 400],
    ['model not found', 404],
    ['missing required parameter messages', 422],
  ])('请求级错误 %s (%i) → 请求级', (message, status) => {
    expect(classifyErrorKind({ status, message })).toBe('request');
  });

  it('invalid_request_error 且不涉及 provider/modelid → 请求级（先重试再切，见函数注释）', () => {
    expect(classifyErrorKind({ status: 400, message: 'invalid_request_error: messages must be an array' })).toBe(
      'request',
    );
  });

  it('invalid_request_error 但提到渠道 → 渠道级', () => {
    expect(classifyErrorKind({ status: 400, message: 'invalid_request_error: no allowed providers' })).toBe('channel');
  });

  it('200 却带未知错误体 → 渠道级（宁切换勿卡死）', () => {
    expect(classifyErrorKind({ status: 200, message: 'something weird' })).toBe('channel');
  });
});

// ---------- 渠道状态五分类 ----------

describe('classifyChannelStatus', () => {
  it('empty response content → ok（请求已到达模型，推理耗尽 max_tokens）', () => {
    expect(classifyChannelStatus('empty response content from model')).toBe('ok');
  });

  it.each(['429 too many requests', 'rate-limited', 'temporarily rate limited'])('%s → limited', (msg) => {
    expect(classifyChannelStatus(msg)).toBe('limited');
  });

  it.each(['invalid_request_error', 'failed to resolve modelid', 'no allowed providers', 'model not found'])(
    '%s → bad（不可钉住）',
    (msg) => {
      expect(classifyChannelStatus(msg)).toBe('bad');
    },
  );

  it.each(['Unauthorized', 'please re-authenticate'])('%s → auth（账号问题，与渠道无关）', (msg) => {
    expect(classifyChannelStatus(msg)).toBe('auth');
  });

  it('未识别文本 → unknown（不拉黑）', () => {
    expect(classifyChannelStatus('weird gateway hiccup')).toBe('unknown');
  });
});

// ---------- unwrap ----------

describe('unwrap', () => {
  it('剥掉 Cline 的 data 包装', () => {
    const r = unwrap({ data: { choices: [{ message: { content: 'OK' } }], provider: 'GMICloud' } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ choices: [{ message: { content: 'OK' } }], provider: 'GMICloud' });
    expect(r.routing.finalProvider).toBe('gmicloud');
    expect(r.error).toBeNull();
  });

  it('字符串错误 → upstream_error + 502', () => {
    const r = unwrap({ error: 'some gateway failure' });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: { message: 'some gateway failure', type: 'upstream_error' } });
    expect(r.error).toBe('some gateway failure');
  });

  it('model not found → 404', () => {
    const r = unwrap({ error: 'model not found: cline-pass/nope' });
    expect(r.status).toBe(404);
  });

  it('对象错误 → 归一为字符串', () => {
    const r = unwrap({ error: { message: 'bad', code: 1 } });
    expect(r.error).toContain('bad');
    expect(r.error).toContain('1');
  });

  it('data 包装内的错误也能识别', () => {
    const r = unwrap({ data: { error: 'wrapped failure' } });
    expect(r.status).toBe(502);
    expect(r.error).toBe('wrapped failure');
  });

  it('带 error 但也有 choices（部分成功）→ 视为成功', () => {
    const r = unwrap({ error: 'ignore me', choices: [{ message: { content: 'OK' } }] });
    expect(r.status).toBe(200);
  });

  it('非对象输入 → 200 空体', () => {
    const r = unwrap(null);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  it('Error 实例也能归一为文本（旧版 JSON.stringify 会得到 {}）', () => {
    const r = unwrap({ error: new Error('boom') });
    expect(r.error).toBe('boom');
  });
});
