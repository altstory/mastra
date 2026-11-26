import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Entity, EntityContent, EntityName, EntityDescription } from '@mastra/playground-ui/components/Entity';
import { Field, FieldDescription, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { MemoryIcon } from '@mastra/playground-ui/icons/MemoryIcon';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useEmbedders } from '@mastra/react/hooks/embedders';
import { useVectors } from '@mastra/react/hooks/vectors';
import { Controller, useWatch } from 'react-hook-form';

import { useAgentEditFormContext } from '../../context/agent-edit-form-context';
import { RegisteredMemoryNotice } from '../registered-memory-notice';
import { SectionHeader, SubSectionHeader } from '@/domains/cms';
import { LLMProviders, LLMModels } from '@/domains/llm';

export function MemoryPage() {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control } = form;
  const isEnabled = useWatch({ control, name: 'memory.enabled' }) ?? false;
  const memoryRef = useWatch({ control, name: 'memoryRef' });

  if (memoryRef) {
    return (
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-4">
          <SectionHeader
            title={studioT('Memory')}
            subtitle={studioT('Configure memory settings for conversation persistence and semantic recall.')}
          />
          <RegisteredMemoryNotice memoryId={memoryRef.memoryId} />
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <SectionHeader
            title={studioT('Memory')}
            subtitle={studioT('Configure memory settings for conversation persistence and semantic recall.')}
          />
          {!readOnly && isEnabled && (
            <Controller
              name="memory.enabled"
              control={control}
              render={({ field }) => <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />}
            />
          )}
        </div>

        {!isEnabled && (
          <div className="py-8">
            <EmptyState
              titleSlot={studioT('Memory is not enabled')}
              descriptionSlot={studioT(
                'Enable memory to store conversation history, add semantic recall for relevant retrieval, or observational memory for long-term learning.',
              )}
              actionSlot={
                !readOnly && (
                  <Controller
                    name="memory.enabled"
                    control={control}
                    render={({ field }) => (
                      <Button icon={<MemoryIcon />} variant="default" size="sm" onClick={() => field.onChange(true)}>
                        {studioT('Enable memory')}
                      </Button>
                    )}
                  />
                )
              }
            />
          </div>
        )}

        {isEnabled && (
          <div className="flex flex-col gap-2">
            <ObservationalMemoryEntity />
            <LastMessagesEntity />
            <SemanticRecallEntity />
            <ReadOnlyEntity />
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function LastMessagesEntity() {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control } = form;
  const lastMessages = useWatch({ control, name: 'memory.lastMessages' });
  const lastMessagesEnabled = lastMessages !== false;

  return (
    <Entity className="flex-col gap-0 overflow-hidden p-0">
      <div className="flex gap-3 px-4 py-3">
        <EntityContent>
          <EntityName>{studioT('Message History')}</EntityName>
          <EntityDescription>{studioT('Number of recent messages to include in context')}</EntityDescription>
        </EntityContent>

        {!readOnly && (
          <Controller
            name="memory.lastMessages"
            control={control}
            render={({ field }) => (
              <Switch
                checked={lastMessagesEnabled}
                onCheckedChange={checked => {
                  field.onChange(checked ? 40 : false);
                  if (checked) {
                    form.setValue('memory.observationalMemory.enabled', false, { shouldDirty: true });
                  }
                }}
              />
            )}
          />
        )}
      </div>

      {lastMessagesEnabled && (
        <div className="border-t border-border bg-background p-4">
          <Controller
            name="memory.lastMessages"
            control={control}
            render={({ field }) => (
              <Input
                id="memory-last-messages"
                type="number"
                min="1"
                step="1"
                value={field.value === false ? '' : (field.value ?? 40)}
                onChange={e => {
                  const value = e.target.value;
                  field.onChange(value === '' ? false : parseInt(value, 10));
                }}
                placeholder="40"
                className="bg-card"
                disabled={readOnly}
              />
            )}
          />
        </div>
      )}
    </Entity>
  );
}

function SemanticRecallEntity() {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control } = form;
  const semanticRecallEnabled = useWatch({ control, name: 'memory.semanticRecall' }) ?? false;

  const { data: vectorsData } = useVectors();
  const { data: embeddersData } = useEmbedders();
  const vectors = vectorsData?.vectors ?? [];
  const embedders = embeddersData?.embedders ?? [];

  return (
    <Entity className="flex-col gap-0 overflow-hidden p-0">
      <div className="flex gap-3 px-4 py-3">
        <EntityContent>
          <EntityName>{studioT('Semantic Recall')}</EntityName>
          <EntityDescription>{studioT('Enable semantic search in memory')}</EntityDescription>
        </EntityContent>

        {!readOnly && (
          <Controller
            name="memory.semanticRecall"
            control={control}
            render={({ field }) => <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />}
          />
        )}
      </div>

      {semanticRecallEnabled && (
        <div className="grid grid-cols-2 gap-4 border-t border-border bg-background p-4">
          <Controller
            name="memory.vector"
            control={control}
            render={({ field }) => (
              <Field className="gap-1.5">
                <FieldLabel>{studioT('Vector Store')}</FieldLabel>
                <FieldDescription className="mt-0 text-subtle-foreground">
                  {studioT('Select a vector store for semantic search')}
                </FieldDescription>
                <Select value={field.value ?? ''} onValueChange={field.onChange} disabled={readOnly}>
                  <SelectTrigger className="bg-card">
                    <SelectValue placeholder={studioT('Select a vector store')} />
                  </SelectTrigger>
                  <SelectContent>
                    {vectors.map(vector => (
                      <SelectItem key={vector.id} value={vector.id}>
                        {vector.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          />

          <Controller
            name="memory.embedder"
            control={control}
            render={({ field }) => (
              <Field className="gap-1.5">
                <FieldLabel>{studioT('Embedder Model')}</FieldLabel>
                <FieldDescription className="mt-0 text-subtle-foreground">
                  {studioT('Select an embedding model for semantic search')}
                </FieldDescription>
                <Select value={field.value ?? ''} onValueChange={field.onChange} disabled={readOnly}>
                  <SelectTrigger className="bg-card">
                    <SelectValue placeholder={studioT('Select an embedder model')} />
                  </SelectTrigger>
                  <SelectContent>
                    {embedders.map(embedder => (
                      <SelectItem key={embedder.id} value={embedder.id}>
                        {embedder.name} ({embedder.provider})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
        </div>
      )}
    </Entity>
  );
}

function ReadOnlyEntity() {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control } = form;

  return (
    <Entity>
      <EntityContent>
        <EntityName>{studioT('Read Only')}</EntityName>
        <EntityDescription>{studioT('Memory is read-only (no new messages stored)')}</EntityDescription>
      </EntityContent>

      {!readOnly && (
        <Controller
          name="memory.readOnly"
          control={control}
          render={({ field }) => <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />}
        />
      )}
    </Entity>
  );
}

function ObservationalMemoryEntity() {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control } = form;
  const observationalMemoryEnabled = useWatch({ control, name: 'memory.observationalMemory.enabled' }) ?? false;

  return (
    <Entity className="flex-col gap-0 overflow-hidden p-0">
      <div className="flex gap-3 px-4 py-3">
        <EntityContent>
          <EntityName>{studioT('Observational Memory')}</EntityName>
          <EntityDescription>
            {studioT('Automatically observe and reflect on conversations to build long-term memory')}
          </EntityDescription>
        </EntityContent>

        {!readOnly && (
          <Controller
            name="memory.observationalMemory.enabled"
            control={control}
            render={({ field }) => (
              <Switch
                checked={field.value ?? false}
                onCheckedChange={checked => {
                  field.onChange(checked);
                  if (checked) {
                    form.setValue('memory.lastMessages', false, { shouldDirty: true });
                  }
                }}
              />
            )}
          />
        )}
      </div>

      {observationalMemoryEnabled && (
        <div className="border-t border-border bg-background p-4">
          <ObservationalMemoryFields />
        </div>
      )}
    </Entity>
  );
}

function ObservationalMemoryFields() {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control, setValue } = form;
  const omProvider = useWatch({ control, name: 'memory.observationalMemory.model.provider' }) ?? '';
  const observerProvider = useWatch({ control, name: 'memory.observationalMemory.observation.model.provider' }) ?? '';
  const reflectorProvider = useWatch({ control, name: 'memory.observationalMemory.reflection.model.provider' }) ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field className="gap-1.5">
          <FieldLabel>{studioT('Provider')}</FieldLabel>
          <FieldDescription className="mt-0 text-subtle-foreground">
            {studioT('Provider for the observer and reflector agents')}
          </FieldDescription>
          <Controller
            name="memory.observationalMemory.model.provider"
            control={control}
            render={({ field }) => (
              <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
                <LLMProviders
                  value={field.value ?? ''}
                  onValueChange={v => {
                    field.onChange(v);
                    setValue('memory.observationalMemory.model.name', '', { shouldDirty: true });
                  }}
                />
              </div>
            )}
          />
        </Field>

        <Field className="gap-1.5">
          <FieldLabel>{studioT('Model')}</FieldLabel>
          <FieldDescription className="mt-0 text-subtle-foreground">
            {studioT('Model for the observer and reflector agents')}
          </FieldDescription>
          <Controller
            name="memory.observationalMemory.model.name"
            control={control}
            render={({ field }) => (
              <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
                <LLMModels value={field.value ?? ''} onValueChange={field.onChange} llmId={omProvider} />
              </div>
            )}
          />
        </Field>

        <Controller
          name="memory.observationalMemory.scope"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Scope')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT(
                  'Whether observations are scoped per thread or shared across all threads for a resource. Resource scope is deprecated and will be removed in a future release.',
                )}
              </FieldDescription>
              <Select value={field.value ?? 'thread'} onValueChange={field.onChange} disabled={readOnly}>
                <SelectTrigger className="bg-card">
                  <SelectValue placeholder={studioT('Select scope')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="thread">{studioT('Thread')}</SelectItem>
                  <SelectItem value="resource">{studioT('Resource (deprecated)')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        />

        <Controller
          name="memory.observationalMemory.shareTokenBudget"
          control={control}
          render={({ field }) => (
            <Field disabled={readOnly} className="gap-1.5">
              <FieldLabel>{studioT('Share Token Budget')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Share token budget between observation and reflection')}
              </FieldDescription>
              <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
            </Field>
          )}
        />
      </div>

      <div className="mt-2 border-t border-border pt-4">
        <ObserverFields observerProvider={observerProvider} />
      </div>
      <div className="mt-2 border-t border-border pt-4">
        <ReflectorFields reflectorProvider={reflectorProvider} />
      </div>
    </div>
  );
}

function ObserverFields({ observerProvider }: { observerProvider: string }) {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control, setValue } = form;

  return (
    <div className="flex flex-col gap-4">
      <SubSectionHeader title={studioT('Observer')} />
      <div className="grid grid-cols-2 gap-4">
        <Field className="gap-1.5">
          <FieldLabel>{studioT('Provider Override')}</FieldLabel>
          <FieldDescription className="mt-0 text-subtle-foreground">
            {studioT('Override the default model provider for the observer')}
          </FieldDescription>
          <Controller
            name="memory.observationalMemory.observation.model.provider"
            control={control}
            render={({ field }) => (
              <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
                <LLMProviders
                  value={field.value ?? ''}
                  onValueChange={v => {
                    field.onChange(v);
                    setValue('memory.observationalMemory.observation.model.name', '', { shouldDirty: true });
                  }}
                />
              </div>
            )}
          />
        </Field>

        <Field className="gap-1.5">
          <FieldLabel>{studioT('Model Override')}</FieldLabel>
          <FieldDescription className="mt-0 text-subtle-foreground">
            {studioT('Override the default model for the observer')}
          </FieldDescription>
          <Controller
            name="memory.observationalMemory.observation.model.name"
            control={control}
            render={({ field }) => (
              <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
                <LLMModels value={field.value ?? ''} onValueChange={field.onChange} llmId={observerProvider} />
              </div>
            )}
          />
        </Field>

        <Controller
          name="memory.observationalMemory.observation.messageTokens"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Message Tokens')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Token count of unobserved messages that triggers observation (default: 30000)')}
              </FieldDescription>
              <Input
                type="number"
                min="1"
                step="1"
                value={field.value ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  field.onChange(v === '' ? undefined : parseInt(v, 10));
                }}
                placeholder="30000"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />

        <Controller
          name="memory.observationalMemory.observation.maxTokensPerBatch"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Max Tokens Per Batch')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Maximum tokens per batch when observing multiple threads (default: 10000)')}
              </FieldDescription>
              <Input
                type="number"
                min="1"
                step="1"
                value={field.value ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  field.onChange(v === '' ? undefined : parseInt(v, 10));
                }}
                placeholder="10000"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />

        <Controller
          name="memory.observationalMemory.observation.bufferTokens"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Buffer Tokens')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT(
                  'Token interval for async buffering (fraction of messageTokens or absolute count, empty to use default 0.2, set 0 to disable)',
                )}
              </FieldDescription>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={field.value === false ? '0' : (field.value ?? '')}
                onChange={e => {
                  const v = e.target.value;
                  if (v === '' || v === undefined) {
                    field.onChange(undefined);
                  } else {
                    const n = parseFloat(v);
                    field.onChange(n === 0 ? false : n);
                  }
                }}
                placeholder="0.2"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />

        <Controller
          name="memory.observationalMemory.observation.bufferActivation"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Buffer Activation')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Ratio (0-1) of buffered observations to activate (default: 0.8)')}
              </FieldDescription>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={field.value ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  field.onChange(v === '' ? undefined : parseFloat(v));
                }}
                placeholder="0.8"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />

        <Controller
          name="memory.observationalMemory.observation.blockAfter"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Block After')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Multiplier or absolute token count for synchronous blocking (default: 1.2)')}
              </FieldDescription>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={field.value ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  field.onChange(v === '' ? undefined : parseFloat(v));
                }}
                placeholder="1.2"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />
      </div>
    </div>
  );
}

function ReflectorFields({ reflectorProvider }: { reflectorProvider: string }) {
  useLocale();
  const { form, readOnly } = useAgentEditFormContext();
  const { control, setValue } = form;

  return (
    <div className="flex flex-col gap-4">
      <SubSectionHeader title={studioT('Reflector')} />
      <div className="grid grid-cols-2 gap-4">
        <Field className="gap-1.5">
          <FieldLabel>{studioT('Provider Override')}</FieldLabel>
          <FieldDescription className="mt-0 text-subtle-foreground">
            {studioT('Override the default model provider for the reflector')}
          </FieldDescription>
          <Controller
            name="memory.observationalMemory.reflection.model.provider"
            control={control}
            render={({ field }) => (
              <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
                <LLMProviders
                  value={field.value ?? ''}
                  onValueChange={v => {
                    field.onChange(v);
                    setValue('memory.observationalMemory.reflection.model.name', '', { shouldDirty: true });
                  }}
                />
              </div>
            )}
          />
        </Field>

        <Field className="gap-1.5">
          <FieldLabel>{studioT('Model Override')}</FieldLabel>
          <FieldDescription className="mt-0 text-subtle-foreground">
            {studioT('Override the default model for the reflector')}
          </FieldDescription>
          <Controller
            name="memory.observationalMemory.reflection.model.name"
            control={control}
            render={({ field }) => (
              <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
                <LLMModels value={field.value ?? ''} onValueChange={field.onChange} llmId={reflectorProvider} />
              </div>
            )}
          />
        </Field>

        <Controller
          name="memory.observationalMemory.reflection.observationTokens"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Observation Tokens')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Token count of observations that triggers reflection (default: 40000)')}
              </FieldDescription>
              <Input
                type="number"
                min="1"
                step="1"
                value={field.value ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  field.onChange(v === '' ? undefined : parseInt(v, 10));
                }}
                placeholder="40000"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />

        <Controller
          name="memory.observationalMemory.reflection.blockAfter"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Block After')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Multiplier or absolute token count for synchronous blocking (default: 1.2)')}
              </FieldDescription>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={field.value ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  field.onChange(v === '' ? undefined : parseFloat(v));
                }}
                placeholder="1.2"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />

        <Controller
          name="memory.observationalMemory.reflection.bufferActivation"
          control={control}
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{studioT('Buffer Activation')}</FieldLabel>
              <FieldDescription className="mt-0 text-subtle-foreground">
                {studioT('Ratio (0-1) controlling when async reflection buffering starts')}
              </FieldDescription>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={field.value ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  field.onChange(v === '' ? undefined : parseFloat(v));
                }}
                placeholder="0.8"
                className="bg-card"
                disabled={readOnly}
              />
            </Field>
          )}
        />
      </div>
    </div>
  );
}
