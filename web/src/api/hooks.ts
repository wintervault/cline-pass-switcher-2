import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useFeedback } from '../feedback.ts';
import { api } from './client.ts';
import type {
  AccountsResponse,
  HistoryEntry,
  MetaInfo,
  ModelsResponse,
  PerModelConfig,
  ProbeResult,
  SecurityResponse,
  TestResult,
  ValidationResult,
} from './types.ts';

export const qk = {
  meta: ['meta'] as const,
  models: ['models'] as const,
  accounts: ['accounts'] as const,
  security: ['security'] as const,
  history: ['history'] as const,
};

export function useModels(): ReturnType<typeof useQuery<ModelsResponse>> {
  return useQuery({ queryKey: qk.models, queryFn: () => api<ModelsResponse>('/api/models') });
}
export function useAccounts(): ReturnType<typeof useQuery<AccountsResponse>> {
  return useQuery({ queryKey: qk.accounts, queryFn: () => api<AccountsResponse>('/api/accounts') });
}
export function useSecurity(): ReturnType<typeof useQuery<SecurityResponse>> {
  return useQuery({ queryKey: qk.security, queryFn: () => api<SecurityResponse>('/api/security') });
}
export function useHistory(): ReturnType<typeof useQuery<{ history: HistoryEntry[] }>> {
  return useQuery({ queryKey: qk.history, queryFn: () => api<{ history: HistoryEntry[] }>('/api/history') });
}

/** 批量失效（多数写操作之后调用，让表格回到服务端真实状态）。 */
export function useRefresh(): () => void {
  const qc = useQueryClient();
  return () => {
    // meta 也要失效：它承载「是否已配置账号」——漏掉会让「尚未配置」提示
    // 在保存账号后继续显示（读的是旧缓存）
    void qc.invalidateQueries({ queryKey: qk.meta });
    void qc.invalidateQueries({ queryKey: qk.models });
    void qc.invalidateQueries({ queryKey: qk.accounts });
    void qc.invalidateQueries({ queryKey: qk.security });
    void qc.invalidateQueries({ queryKey: qk.history });
  };
}

/**
 * 写操作一律在**这里**给回执，而不是各调用点自己记得弹。
 *
 * 起因：功能做完不给任何反馈，用户不知道「到底成了没有」。把成功与失败的提示
 * 收进 mutation 本身，调用点就不存在「忘了弹」的可能——这是结构性保证，
 * 不是纪律要求。调用点想说得更具体时，用变量里的 `note` 覆盖默认成功文案。
 *
 * 失败的文案统一带上「哪件事失败了 + 服务端给的原因」，不允许只显示「失败」。
 */
export function useSaveModelConfig() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: (vars: { modelId: string; config: PerModelConfig; note?: string }) =>
      api<{ ok: boolean }>('/api/config', { json: { perModel: { [vars.modelId]: vars.config } } }),
    onSuccess: (_data, vars) => {
      refresh();
      fb.ok(vars.note ?? '路由配置已保存');
    },
    onError: (err) => fb.fail('保存路由配置失败', err),
  });
}

export function useProbe() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: (modelId: string) => api<ProbeResult>('/api/probe', { json: { model: modelId } }),
    onSuccess: (r) => {
      refresh();
      if (r.ok) fb.ok(`探测完成：${r.upstreams.length} 个可用渠道`);
      else fb.fail('探测失败', r.error ?? '网关未返回渠道清单');
    },
    onError: (err) => fb.fail('探测失败', err),
  });
}

export function useValidate() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: (modelId: string) => api<ValidationResult>('/api/validate-upstreams', { json: { model: modelId } }),
    onSuccess: (r) => {
      refresh();
      const s = r.summary;
      fb.ok(`校验完成：可用 ${s.ok ?? 0} · 限流 ${s.limited ?? 0} · 不可钉 ${s.bad ?? 0} · key 错误 ${s.auth ?? 0}`);
    },
    onError: (err) => fb.fail('校验失败', err),
  });
}

export function useTest() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: (vars: { model: string; upstreams: string[]; exclude: string[] }) =>
      api<TestResult>('/api/test', { json: vars }),
    onSuccess: (r) => {
      refresh();
      if (r.ok) fb.ok(`测试通过：命中 ${r.actual ?? r.actualName ?? '未知'}${r.ms ? `（${r.ms}ms）` : ''}`);
      else fb.fail('测试失败', r.error ?? '请求未成功');
    },
    onError: (err) => fb.fail('测试失败', err),
  });
}

export function useFetchOfficial() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; sources: string[]; found: number; added: string[]; knownModels: string[] }>(
        '/api/fetch-official-models',
        { json: {} },
      ),
    onSuccess: (r) => {
      refresh();
      if (r.added.length) fb.ok(`已拉取官方清单：新增 ${r.added.length} 个模型`);
      else fb.info(`清单已是最新（官方 ${r.found} 个）`);
    },
    onError: (err) => fb.fail('拉取官方模型清单失败', err),
  });
}

export function useSaveAccounts() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: (vars: { payload: unknown; note?: string }) =>
      api<{ ok: boolean }>('/api/accounts', { json: vars.payload }),
    onSuccess: (_data, vars) => {
      refresh();
      fb.ok(vars.note ?? '账号池已保存');
    },
    onError: (err) => fb.fail('保存账号失败', err),
  });
}

export function useTestAccount() {
  const fb = useFeedback();
  return useMutation({
    mutationFn: (vars: { payload: { key: string } | { index: number }; label: string }) =>
      api<{ ok: boolean; ms: number; error?: string; note?: string }>('/api/accounts/test', { json: vars.payload }),
    onSuccess: (r, vars) => {
      if (r.ok) fb.ok(`${vars.label} 可用（${r.ms}ms）${r.note ?? ''}`);
      else fb.fail(`${vars.label} 不可用`, r.error ?? '未通过连通性测试');
    },
    onError: (err, vars) => fb.fail(`${vars.label} 测试请求失败`, err),
  });
}

export function useSaveSecurity() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: (vars: { payload: Record<string, unknown>; note?: string }) =>
      api<{ ok: boolean }>('/api/security', { json: vars.payload }),
    onSuccess: (_data, vars) => {
      refresh();
      fb.ok(vars.note ?? '安全设置已保存');
    },
    onError: (err) => fb.fail('保存安全设置失败', err),
  });
}

export function useSaveExposeCatalog() {
  const refresh = useRefresh();
  const fb = useFeedback();
  return useMutation({
    mutationFn: (exposeCatalog: boolean) => api<{ ok: boolean }>('/api/security', { json: { exposeCatalog } }),
    onSuccess: (_data, exposeCatalog) => {
      refresh();
      fb.ok(exposeCatalog ? '已开启：/v1/models 返回完整目录' : '已关闭：/v1/models 只返回订阅模型');
    },
    onError: (err) => fb.fail('切换目录暴露失败', err),
  });
}

export function useMeta(): ReturnType<typeof useQuery<MetaInfo>> {
  return useQuery({ queryKey: qk.meta, queryFn: () => api<MetaInfo>('/api/meta') });
}
