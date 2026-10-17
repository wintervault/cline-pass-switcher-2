/**
 * 非流式请求的「内部流式」拼装器（设计与实测见 docs/timeouts.md）。
 *
 * 上游的非流式路径对大上下文明显更慢：同一份 10 万 token 负载，流式 13s、
 * 非流式 >60s（会撞单次尝试超时，重试再吃掉预算 → 502）。客户端要的是
 * `stream:false` 的完整 JSON，那就向上游要流、本地拼成那份 JSON——对客户端契约
 * 零变化，却拿到流式的速度。
 *
 * 纯逻辑：不碰网络。输入是 SSE 文本块（可能被任意切分），输出是拼好的 body 或错误。
 */

import { errText } from '../upstream/response.ts';

export interface CollectResult {
  /** 拼好的 OpenAI 形状响应；出错时为 null。 */
  body: Record<string, unknown> | null;
  /** 流里带回的错误文本；成功时为 null。 */
  error: string | null;
}

interface ToolCallState {
  id?: string;
  type?: string;
  name: string;
  args: string;
}

interface ReasoningDetailState {
  /** 详情块里的原始字段（type/format/index…），text 单独累积 */
  meta: Record<string, unknown>;
  text: string;
}

interface ChoiceState {
  role: string;
  content: string;
  hasContent: boolean;
  reasoning: string;
  hasReasoning: boolean;
  /** 按 detail.index（缺省时按数组下标）累积——网关每个 delta 只发一块 */
  reasoningDetails: Map<number, ReasoningDetailState>;
  /** 按 tool_calls[].index 累积 */
  toolCalls: ToolCallState[];
  finishReason: string | null;
  logprobs: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export class StreamCollector {
  #buf = '';
  #id: unknown = null;
  #model: unknown = null;
  #created: unknown = null;
  #provider: unknown = null;
  #systemFingerprint: unknown = null;
  #serviceTier: unknown = null;
  #usage: unknown = null;
  #providerMetadata: unknown = null;
  #error: string | null = null;
  #sawDone = false;
  #sawFinish = false;
  #choices = new Map<number, ChoiceState>();

  /** 喂一段 SSE 文本（可以是任意切分的片段）。 */
  push(text: string): void {
    if (!text) return;
    this.#buf += text;
    for (;;) {
      const nl = this.#buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl).replace(/\r$/, '');
      this.#buf = this.#buf.slice(nl + 1);
      this.#consume(line);
    }
  }

  /** 流结束：拼装结果。没有 [DONE] 也没有 finish_reason 视为被截断（不能当成功返回）。 */
  finish(): CollectResult {
    // 收尾时残留的半行可能仍是一个完整 data（上游没补换行）
    if (this.#buf.trim()) {
      const rest = this.#buf;
      this.#buf = '';
      this.#consume(rest);
    }
    if (this.#error !== null) return { body: null, error: this.#error };
    if (this.#choices.size === 0) return { body: null, error: 'empty stream' };

    const choices = [...this.#choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, st]) => {
        const message: Record<string, unknown> = { role: st.role || 'assistant' };
        const toolCalls = st.toolCalls
          .filter((t): t is ToolCallState => t !== undefined)
          .map((t) => ({
            id: t.id ?? '',
            type: t.type ?? 'function',
            function: { name: t.name, arguments: t.args },
          }));
        // 有工具调用且没有正文时，content 按 OpenAI 约定为 null
        message['content'] = st.hasContent ? st.content : toolCalls.length ? null : '';
        if (st.hasReasoning) message['reasoning'] = st.reasoning;
        if (st.reasoningDetails.size > 0) {
          message['reasoning_details'] = [...st.reasoningDetails.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, d]) => ({ ...d.meta, text: d.text }));
        }
        if (toolCalls.length > 0) message['tool_calls'] = toolCalls;

        const choice: Record<string, unknown> = {
          index,
          message,
          finish_reason: st.finishReason ?? 'stop',
        };
        if (st.logprobs !== null) choice['logprobs'] = st.logprobs;
        return choice;
      });

    const body: Record<string, unknown> = {
      id: this.#id,
      object: 'chat.completion',
      created: this.#created,
      model: this.#model,
      choices,
    };
    if (this.#provider !== null) body['provider'] = this.#provider;
    if (this.#systemFingerprint !== null) body['system_fingerprint'] = this.#systemFingerprint;
    if (this.#serviceTier !== null) body['service_tier'] = this.#serviceTier;
    if (this.#usage !== null) body['usage'] = this.#usage;
    if (this.#providerMetadata !== null) body['provider_metadata'] = this.#providerMetadata;

    const truncated = !this.#sawDone && !this.#sawFinish;
    if (truncated) return { body: null, error: 'stream ended unexpectedly' };
    return { body, error: null };
  }

  #consume(line: string): void {
    const trimmed = line.trim();
    // 空行、注释行、event:/id:/retry: 等字段一律忽略——只要 data
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      this.#sawDone = true;
      return;
    }

    let chunk: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      const rec = asRecord(parsed);
      if (!rec) return;
      chunk = rec;
    } catch {
      return; // 上游偶发不完整行：跳过，不因此判失败
    }

    if (chunk['error'] !== undefined && chunk['error'] !== null) {
      this.#error = errText(chunk['error']);
      return;
    }

    for (const key of ['id', 'model', 'created', 'provider', 'system_fingerprint', 'service_tier'] as const) {
      const value = chunk[key];
      if (value !== undefined && value !== null) {
        if (key === 'id') this.#id = value;
        else if (key === 'model') this.#model = value;
        else if (key === 'created') this.#created = value;
        else if (key === 'provider') this.#provider = value;
        else if (key === 'system_fingerprint') this.#systemFingerprint = value;
        else this.#serviceTier = value;
      }
    }
    if (chunk['usage'] !== undefined && chunk['usage'] !== null) this.#usage = chunk['usage'];
    if (chunk['provider_metadata'] !== undefined && chunk['provider_metadata'] !== null) {
      this.#providerMetadata = chunk['provider_metadata'];
    }

    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
    for (const raw of choices) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const index = typeof rec['index'] === 'number' ? rec['index'] : 0;
      const st = this.#choice(index);

      const delta = asRecord(rec['delta']);
      if (delta) {
        if (typeof delta['role'] === 'string') st.role = delta['role'];
        if (typeof delta['content'] === 'string') {
          st.content += delta['content'];
          st.hasContent = true;
        }
        if (typeof delta['reasoning'] === 'string') {
          st.reasoning += delta['reasoning'];
          st.hasReasoning = true;
        }
        const details = Array.isArray(delta['reasoning_details']) ? delta['reasoning_details'] : [];
        for (let i = 0; i < details.length; i++) {
          const d = asRecord(details[i]);
          if (!d) continue;
          const key = typeof d['index'] === 'number' ? d['index'] : i;
          const slot = st.reasoningDetails.get(key) ?? { meta: { ...d }, text: '' };
          if (typeof d['text'] === 'string') slot.text += d['text'];
          st.reasoningDetails.set(key, slot);
        }
        const calls = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : [];
        for (let i = 0; i < calls.length; i++) {
          const c = asRecord(calls[i]);
          if (!c) continue;
          const key = typeof c['index'] === 'number' ? c['index'] : i;
          const slot = st.toolCalls[key] ?? { name: '', args: '' };
          if (typeof c['id'] === 'string') slot.id = c['id'];
          if (typeof c['type'] === 'string') slot.type = c['type'];
          const fn = asRecord(c['function']);
          if (fn) {
            if (typeof fn['name'] === 'string') slot.name += fn['name'];
            if (typeof fn['arguments'] === 'string') slot.args += fn['arguments'];
          }
          st.toolCalls[key] = slot;
        }
      }

      if (typeof rec['finish_reason'] === 'string') {
        st.finishReason = rec['finish_reason'];
        this.#sawFinish = true;
      }
      if (rec['logprobs'] !== undefined && rec['logprobs'] !== null) st.logprobs = rec['logprobs'];
    }
  }

  #choice(index: number): ChoiceState {
    let st = this.#choices.get(index);
    if (!st) {
      st = {
        role: '',
        content: '',
        hasContent: false,
        reasoning: '',
        hasReasoning: false,
        reasoningDetails: new Map(),
        toolCalls: [],
        finishReason: null,
        logprobs: null,
      };
      this.#choices.set(index, st);
    }
    return st;
  }
}
