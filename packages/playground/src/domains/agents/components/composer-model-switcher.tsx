import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useChatMessages } from '@mastra/playground-ui/domains/chat/context/chat-context';
import { ModelSettingsPicker, cleanProviderId } from '@mastra/playground-ui/domains/llm';
import type { ModelPickerProvider } from '@mastra/playground-ui/domains/llm';
import { IconExclamationTriangle } from '@mastra/playground-ui/icons/central/IconExclamationTriangle';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { Trans } from '@mastra/playground-ui/lib/i18n/trans';
import { useLLMProviders } from '@mastra/react/hooks/llm';
import { useAgentSettings } from '../context/agent-context';
import { usePlaygroundModelOptional } from '../context/playground-model-context';
import { useIsManagedAccount } from '@/domains/account/account-context';
import { useBuilderFilteredModels, useBuilderFilteredProviders, useBuilderModelPolicy } from '@/domains/agent-builder';
import { useAgentBuilderAllowedModels } from '@/domains/agent-builder/hooks/use-agent-builder-allowed-models';
import { findProviderById } from '@/domains/llm';
import { useAllModels } from '@/domains/llm/hooks/use-filtered-models';
import { useFilteredProviders } from '@/domains/llm/hooks/use-filtered-providers';

export const ComposerModelSwitcher = () => {
  useLocale();
  const managed = useIsManagedAccount();
  const messages = useChatMessages();
  const selection = usePlaygroundModelOptional();
  const { settings, setSettings } = useAgentSettings();
  const { data: dataProviders, isLoading: providersLoading } = useLLMProviders();
  const policy = useBuilderModelPolicy();
  const allProviders = dataProviders?.providers ?? [];
  const filteredProviders = useBuilderFilteredProviders(allProviders, policy);
  const sortedProviders = useFilteredProviders(
    managed ? allProviders.filter(provider => provider.id === 'altflow') : filteredProviders,
    '',
    false,
  );
  const allowedModels = useBuilderFilteredModels(useAllModels(allProviders), policy);
  const pickerProviders: ModelPickerProvider[] = sortedProviders.map(provider => ({
    id: provider.id,
    name: provider.name,
    connected: provider.connected,
    models: allowedModels
      .filter(model => model.provider === provider.id)
      .map(model => ({ id: model.model, name: provider.modelNames?.[model.model], releaseDate: model.releaseDate })),
  }));

  if (!selection) return null;
  const resolveProviderId = (providerId: string) => {
    const cleaned = cleanProviderId(providerId);
    return findProviderById(allProviders, cleaned)?.id || cleaned;
  };
  // Reserve the picker footprint so the action row doesn't collapse then pop in.
  if (providersLoading) {
    // Lighter than the default `bg-muted`: the composer surface is already light, so the
    // skeleton would otherwise read as a dark pill instead of a placeholder.
    return (
      <Skeleton
        className="h-control-sm w-32 rounded-full bg-fill-subtle before:via-fill"
        data-testid="composer-model-switcher-skeleton"
      />
    );
  }

  const { provider: selectedProvider, model: selectedModel, agentModel, resetModel, setModel } = selection;

  const modelLocked = !managed && policy.active && policy.pickerVisible === false;

  // Resolve the full provider ID (handles gateway prefix, e.g., 'custom' -> 'acme/custom')
  const fullProviderId = resolveProviderId(selectedProvider);

  const reasoning = allProviders.find(provider => provider.id === fullProviderId)?.modelReasoning?.[selectedModel];
  const storedLevel = settings?.modelSettings.providerOptions?.[cleanProviderId(fullProviderId)]?.reasoningLevel;
  const level =
    typeof storedLevel === 'string' && reasoning?.levels.includes(storedLevel) ? storedLevel : reasoning?.defaultLevel;
  const setReasoning = (provider: string, nextLevel?: string) => {
    if (!setSettings) return;
    // Reasoning levels belong to a model route. Never carry a previous route's choice across a switch.
    const providerOptions = Object.fromEntries(
      Object.entries(settings?.modelSettings.providerOptions ?? {})
        .map(([key, options]) => {
          const { reasoningLevel: _level, ...rest } = options;
          return [key, rest];
        })
        .filter(([, options]) => Object.keys(options).length),
    );
    const key = cleanProviderId(provider);
    if (nextLevel !== undefined) providerOptions[key] = { ...providerOptions[key], reasoningLevel: nextLevel };
    setSettings({ modelSettings: { ...settings?.modelSettings, providerOptions } });
  };

  return (
    <ModelSettingsPicker
      modelLocked={modelLocked}
      reasoningLocked={!managed && modelLocked}
      teamwork={{
        enabled: settings?.modelSettings.teamwork ?? false,
        hasMessages: messages.length > 0,
        onChange: teamwork => setSettings?.({ modelSettings: { ...settings?.modelSettings, teamwork } }),
      }}
      providers={pickerProviders}
      value={fullProviderId ? { provider: fullProviderId, model: selectedModel } : undefined}
      onValueChange={({ provider, model }) => {
        if (provider === fullProviderId && model === selectedModel) return;
        setReasoning(
          provider,
          allProviders.find(entry => entry.id === provider)?.modelReasoning?.[model]?.defaultLevel,
        );
        setModel(provider, model);
      }}
      defaultModel={agentModel && { provider: resolveProviderId(agentModel.provider), model: agentModel.model }}
      reset={
        resetModel && {
          label: studioT("Reset to the agent's model"),
          onClick: () => {
            const provider = resolveProviderId(agentModel?.provider ?? '');
            setReasoning(
              provider,
              allProviders.find(entry => entry.id === provider)?.modelReasoning?.[agentModel?.model ?? '']
                ?.defaultLevel,
            );
            resetModel();
          },
        }
      }
      reasoning={
        reasoning && level !== undefined
          ? {
              levels: reasoning.levels,
              value: level,
              onChange: next => setReasoning(fullProviderId, next),
            }
          : undefined
      }
    />
  );
};

export const ComposerModelWarning = () => {
  useLocale();
  const managed = useIsManagedAccount();
  const selection = usePlaygroundModelOptional();
  const { data: dataProviders, isLoading: providersLoading } = useLLMProviders({ queryOptions: { enabled: !managed } });
  const policy = useBuilderModelPolicy();
  const {
    models: allowedModels,
    isLoading: allowedModelsLoading,
    isError: allowedModelsError,
  } = useAgentBuilderAllowedModels();

  if (managed || providersLoading || !selection) return null;

  const providers = dataProviders?.providers || [];
  const { provider, model, modelWarning } = selection;
  const currentModelProvider = cleanProviderId(provider);
  const currentProvider = findProviderById(providers, currentModelProvider);
  const selectedModel = model;

  const stale =
    Boolean(currentModelProvider && selectedModel) &&
    policy.active &&
    policy.allowed !== undefined &&
    !allowedModelsLoading &&
    !allowedModelsError &&
    !allowedModels.some(m => cleanProviderId(m.provider) === currentModelProvider && m.model === selectedModel);

  const showProviderWarning = currentProvider && !currentProvider.connected;

  if (!modelWarning && !stale && !showProviderWarning) return null;

  const envVar =
    currentProvider && Array.isArray(currentProvider.envVar)
      ? currentProvider.envVar.join(', ')
      : currentProvider?.envVar;

  return (
    <div className="flex flex-col gap-1 px-3 pb-1.5">
      {(modelWarning || stale) && (
        <div
          className="flex max-w-full min-w-0 items-start gap-1 text-warning-foreground"
          data-testid="composer-model-stale-warning"
          role="alert"
        >
          <IconExclamationTriangle className="mt-0.5 size-icon-xs shrink-0" />
          <Txt as="span" variant="caption" className="min-w-0 break-words">
            {modelWarning || (
              <>
                <code className="rounded bg-warning-subtle px-1 py-0.5 break-all text-warning-subtle-foreground">
                  {provider}/{selectedModel}
                </code>{' '}
                {studioT('is no longer allowed by admin policy. Pick a different model.')}
              </>
            )}
          </Txt>
        </div>
      )}
      {showProviderWarning && (
        <div className="flex max-w-full min-w-0 items-start gap-1 text-warning-foreground">
          <IconExclamationTriangle className="mt-0.5 size-icon-xs shrink-0" />
          <Txt as="span" variant="caption" className="min-w-0 break-words">
            <Trans
              id="Set {part0} to use this provider"
              values={{
                part0: (
                  <code className="rounded bg-warning-subtle px-1 py-0.5 break-all text-warning-subtle-foreground">
                    {envVar}
                  </code>
                ),
              }}
            />
          </Txt>
        </div>
      )}
    </div>
  );
};
