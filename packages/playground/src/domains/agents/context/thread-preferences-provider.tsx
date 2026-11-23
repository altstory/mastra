import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cleanProviderId } from '@mastra/playground-ui/domains/llm';
import { useServerPreference } from '@mastra/playground-ui/hooks/use-server-preference';
import { t } from '@mastra/playground-ui/lib/i18n';
import { useLLMProviders } from '@mastra/react/hooks/llm';
import type { ReactNode } from 'react';
import { AgentSettingsContext } from './agent-context';
import { PlaygroundModelContext } from './playground-model-context';
import { threadPreferencesSchema } from './thread-preferences';
import { useAccount, useIsManagedAccount } from '@/domains/account/account-context';
import { useAgentBuilderAllowedModels } from '@/domains/agent-builder/hooks/use-agent-builder-allowed-models';
import { useBuilderSettings } from '@/domains/agent-builder/hooks/use-builder-settings';
import { resolveChatSettings } from '@/domains/agents/utils/chat-settings';
import type { AgentSettingsType } from '@/types';

export interface ThreadPreferencesProviderProps {
  children: ReactNode;
  agentId: string;
  threadId: string;
  defaultProvider: string;
  defaultModel: string;
  defaultSettings?: AgentSettingsType;
}

export function ThreadPreferencesProvider(props: ThreadPreferencesProviderProps) {
  const storageKey = `mastra-thread-preferences-${JSON.stringify([props.agentId, props.threadId])}`;
  return <ThreadPreferencesState key={storageKey} {...props} storageKey={storageKey} />;
}

function ThreadPreferencesState({
  children,
  defaultProvider,
  defaultModel,
  defaultSettings,
  storageKey,
  agentId,
  threadId,
}: ThreadPreferencesProviderProps & { storageKey: string }) {
  const account = useAccount();
  const managed = useIsManagedAccount();
  const saved = useServerPreference({
    kind: 'thread',
    id: JSON.stringify([agentId, threadId]),
    accountId: account?.user.id,
    legacyKey: storageKey,
    defaultValue: {},
    schema: threadPreferencesSchema,
  });
  const preferences = saved.value;
  const setPreferences = saved.setValue;
  const { data: providers } = useLLMProviders({ queryOptions: { enabled: managed } });

  const { data: builderSettings, isError: policyError } = useBuilderSettings();
  const policy = managed ? undefined : builderSettings?.modelPolicy;
  const {
    models: allowedModels,
    isLoading: allowedModelsLoading,
    isError: allowedModelsError,
  } = useAgentBuilderAllowedModels({ enabled: policy?.active === true });
  const needsAllowlist = policy?.active && policy.allowed !== undefined;
  const policyResolved =
    !managed &&
    Boolean(builderSettings) &&
    !policyError &&
    !(needsAllowlist && (allowedModelsLoading || allowedModelsError));
  const savedSelection = preferences.selection;
  const allowed =
    !policy?.active ||
    policy.allowed === undefined ||
    allowedModels.some(
      entry =>
        cleanProviderId(entry.provider) === cleanProviderId(savedSelection?.provider ?? '') &&
        (!savedSelection?.model || entry.model === savedSelection.model),
    );
  const locked = policy?.active && policy.pickerVisible === false;
  // Never send a restored override before policy resolution, or when it is no longer allowed.
  const selection = policyResolved && !locked && allowed ? savedSelection : undefined;
  // A locked default comes from the policy itself, not the available-model catalog.
  const usePolicyDefault = !policyError && policy?.active && (locked || (policyResolved && savedSelection && !allowed));
  const policyDefault = usePolicyDefault ? policy?.default : undefined;
  const modelWarning =
    !managed && (policyError || (needsAllowlist && allowedModelsError && !locked))
      ? 'Unable to verify model policy. Using the agent default until policy data is available. Your saved model is unchanged.'
      : undefined;
  const provider = selection?.provider ?? policyDefault?.provider ?? defaultProvider;
  const model = selection?.model ?? policyDefault?.modelId ?? defaultModel;
  const modelOverride = (selection || policyDefault) && provider && model ? `${provider}/${model}` : undefined;
  const providerId = cleanProviderId(provider);
  const managedLevel = preferences.modelSettings?.providerOptions?.[providerId]?.reasoningLevel;
  const supportedLevels = providers?.providers.find(entry => entry.id === providerId)?.modelReasoning?.[model]?.levels;
  const settings = resolveChatSettings(
    defaultSettings,
    // Reasoning belongs to the saved model too. If policy replaces that model,
    // inherit the new route's defaults instead of sending the old route's level.
    managed
      ? typeof managedLevel === 'string' && supportedLevels?.includes(managedLevel)
        ? { modelSettings: { providerOptions: { [providerId]: { reasoningLevel: managedLevel } } } }
        : undefined
      : policyResolved && !locked && (!savedSelection || selection) && preferences.modelSettings
        ? { modelSettings: preferences.modelSettings }
        : undefined,
  );

  settings.modelSettings.teamwork = preferences.modelSettings?.teamwork ?? false;

  if (saved.isLoading) return <Txt tone="muted">{t('Loading...')}</Txt>;
  if (saved.error) return <Button onClick={saved.retry}>{t('Retry')}</Button>;

  return (
    <PlaygroundModelContext.Provider
      value={{
        provider,
        model,
        modelOverride,
        modelWarning,
        agentModel: defaultProvider && defaultModel ? { provider: defaultProvider, model: defaultModel } : undefined,
        resetModel:
          !managed && savedSelection
            ? () => setPreferences(previous => ({ ...previous, selection: undefined }))
            : undefined,
        setProvider: provider => setPreferences(previous => ({ ...previous, selection: { provider, model: '' } })),
        setModel: (provider, model) => setPreferences(previous => ({ ...previous, selection: { provider, model } })),
      }}
    >
      <AgentSettingsContext.Provider
        value={{
          settings,
          setSettings: settings => setPreferences(previous => ({ ...previous, modelSettings: settings.modelSettings })),
          resetAll: () => setPreferences(previous => ({ ...previous, modelSettings: undefined })),
        }}
      >
        {children}
      </AgentSettingsContext.Provider>
    </PlaygroundModelContext.Provider>
  );
}
