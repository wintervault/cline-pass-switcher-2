import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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
    void qc.invalidateQueries({ queryKey: qk.models });
    void qc.invalidateQueries({ queryKey: qk.accounts });
    void qc.invalidateQueries({ queryKey: qk.security });
    void qc.invalidateQueries({ queryKey: qk.history });
  };
}

export function useSaveModelConfig() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (vars: { modelId: string; config: PerModelConfig }) =>
      api<{ ok: boolean }>('/api/config', { json: { perModel: { [vars.modelId]: vars.config } } }),
    onSuccess: refresh,
  });
}

export function useProbe() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (modelId: string) => api<ProbeResult>('/api/probe', { json: { model: modelId } }),
    onSuccess: refresh,
  });
}

export function useValidate() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (modelId: string) => api<ValidationResult>('/api/validate-upstreams', { json: { model: modelId } }),
    onSuccess: refresh,
  });
}

export function useTest() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (vars: { model: string; upstreams: string[]; exclude: string[] }) =>
      api<TestResult>('/api/test', { json: vars }),
    onSuccess: refresh,
  });
}

export function useFetchOfficial() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; sources: string[]; found: number; added: string[]; knownModels: string[] }>(
        '/api/fetch-official-models',
        { json: {} },
      ),
    onSuccess: refresh,
  });
}

export function useSaveAccounts() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (payload: unknown) => api<{ ok: boolean }>('/api/accounts', { json: payload }),
    onSuccess: refresh,
  });
}

export function useTestAccount() {
  return useMutation({
    mutationFn: (payload: { key: string } | { index: number }) =>
      api<{ ok: boolean; ms: number; error?: string; note?: string }>('/api/accounts/test', { json: payload }),
  });
}

export function useSaveSecurity() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => api<{ ok: boolean }>('/api/security', { json: payload }),
    onSuccess: refresh,
  });
}

export function useSaveExposeCatalog() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (exposeCatalog: boolean) => api<{ ok: boolean }>('/api/security', { json: { exposeCatalog } }),
    onSuccess: refresh,
  });
}

export function useMeta(): ReturnType<typeof useQuery<MetaInfo>> {
  return useQuery({ queryKey: ['meta'], queryFn: () => api<MetaInfo>('/api/meta') });
}
