import { useMastraClient } from '@mastra/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetStateAction } from 'react';
import { z } from 'zod/v4';
import { useLocalStorageState } from './use-local-storage-state';
import { t } from '@/lib/i18n';
import { toast } from '@/utils/toast';

const responseSchema = z.object({ value: z.record(z.string(), z.unknown()), revision: z.number().int().nonnegative() });
type Entry = z.infer<typeof responseSchema>;
interface PreferenceOptions<T> {
  kind: 'memory' | 'thread' | 'agent' | 'chat';
  id: string;
  accountId?: string;
  schema: z.ZodType<T>;
  defaultValue: T;
  legacyKey?: string;
  serialize?: (value: T) => string;
}
const record = z.record(z.string(), z.unknown());
function difference(previous: unknown, next: unknown): Record<string, unknown> {
  const before = record.parse(previous);
  const after = record.parse(next);
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (after[key] === undefined) patch[key] = null;
    else if (record.safeParse(before[key]).success && record.safeParse(after[key]).success)
      patch[key] = difference(before[key], after[key]);
    else patch[key] = after[key];
  }
  return patch;
}

export function useServerPreference<T extends object>({
  kind,
  id,
  accountId,
  schema,
  defaultValue,
  legacyKey,
  serialize,
}: PreferenceOptions<T>) {
  const client = useMastraClient();
  const queries = useQueryClient();
  const [localValue, setLocalValue] = useLocalStorageState({
    initialKey: accountId
      ? undefined
      : (legacyKey ?? `mastra-preferences-${JSON.stringify([client.options.baseUrl, kind, id])}`),
    defaultValue,
    schema,
    serialize,
  });
  const queryKey = ['account-preference', client.options.baseUrl, client.options.apiPrefix, accountId, kind, id];
  const request = async (patch?: Record<string, unknown>, importing = false): Promise<Entry> => {
    const params = new URLSearchParams({ kind, id });
    const response = await fetch(`${client.options.baseUrl.replace(/\/$/, '')}/account-preferences?${params}`, {
      method: patch ? 'POST' : 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: { ...client.options.headers, 'Content-Type': 'application/json' },
      body: patch
        ? JSON.stringify({ kind, id, patch, ...(importing ? { import: true } : {}) }, (_key, value: unknown) =>
            value === undefined ? null : value,
          )
        : undefined,
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      const failure = new Error(error.success ? error.data.error : t('Failed to save settings'));
      if (importing && response.status === 404) return request(); // Unattributed legacy chat: keep its backup, never adopt it.
      throw failure;
    }
    return responseSchema.parse(body);
  };
  const query = useQuery({
    queryKey,
    enabled: Boolean(accountId),
    retry: false,
    queryFn: async () => {
      const entry = await request();
      if (!legacyKey) return entry;
      let backup: string | null;
      try {
        backup = localStorage.getItem(legacyKey);
      } catch {
        return entry;
      }
      if (!backup) return entry;
      let legacy: unknown;
      try {
        legacy = JSON.parse(backup);
      } catch {
        return entry;
      }
      const parsed = schema.safeParse(legacy);
      if (!parsed.success) return entry;
      const saved = await request(record.parse(parsed.data), true);
      // A 404 import returns the unchanged missing entry; ownership was not proven.
      if (!saved.revision) return saved;
      try {
        if (localStorage.getItem(legacyKey) === backup) localStorage.removeItem(legacyKey);
      } catch {
        /* The server copy is durable. */
      }
      return saved;
    },
  });
  const mutation = useMutation({
    scope: { id: JSON.stringify(queryKey) },
    mutationFn: (update: SetStateAction<T>) => {
      const current = queries.getQueryData<Entry>(queryKey);
      if (!current) throw new Error(t('Settings are not available. Please retry.'));
      const previous = schema.parse(current.value);
      const next = typeof update === 'function' ? update(previous) : update;
      return request(difference(previous, next));
    },
    onMutate: async () => {
      await queries.cancelQueries({ queryKey });
    },
    onSuccess: entry => {
      queries.setQueryData<Entry>(queryKey, current =>
        !current || entry.revision >= current.revision ? entry : current,
      );
    },
    onError: error => {
      toast.error(error.message);
    },
    onSettled: () => queries.invalidateQueries({ queryKey }),
  });
  if (!accountId) {
    return {
      value: localValue,
      setValue: setLocalValue,
      isLoading: false,
      isSaving: false,
      error: null,
      retry: () => {},
    };
  }
  return {
    value: query.data ? schema.parse(query.data.value) : defaultValue,
    setValue: mutation.mutate,
    isLoading: query.isPending,
    isSaving: mutation.isPending,
    error: query.error ?? mutation.error,
    retry: () => {
      mutation.reset();
      void query.refetch();
    },
  };
}
