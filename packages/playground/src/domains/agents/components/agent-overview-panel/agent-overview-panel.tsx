import { Badge } from '@mastra/playground-ui/components/Badge';
import { InlineCode } from '@mastra/playground-ui/components/InlineCode';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { AgentConfigSurface } from '@mastra/playground-ui/domains/agents/config/agent-config-surface';
import { AgentMemoryConfig } from '@mastra/playground-ui/domains/agents/config/agent-memory-config';
import { AgentMetadataSection } from '@mastra/playground-ui/domains/agents/config/agent-metadata-section';
import { AgentSystemPrompt } from '@mastra/playground-ui/domains/agents/config/agent-system-prompt';
import { AgentMetadataWorkspaceToolsList } from '@mastra/playground-ui/domains/agents/config/agent-workspace-tools-list';
import { extractPrompt } from '@mastra/playground-ui/domains/agents/extract-prompt';
import { useEntityRequestContext } from '@mastra/playground-ui/domains/request-context/hooks/use-entity-request-context';
import { AgentIcon } from '@mastra/playground-ui/icons/AgentIcon';
import { IconBox2 } from '@mastra/playground-ui/icons/central/IconBox2';
import { IconBrain } from '@mastra/playground-ui/icons/central/IconBrain';
import { IconChip } from '@mastra/playground-ui/icons/central/IconChip';
import { IconFolder1 } from '@mastra/playground-ui/icons/central/IconFolder1';
import { IconGauge } from '@mastra/playground-ui/icons/central/IconGauge';
import { IconGlobe } from '@mastra/playground-ui/icons/central/IconGlobe';
import { IconMaintenance } from '@mastra/playground-ui/icons/central/IconMaintenance';
import { IconSignalTower } from '@mastra/playground-ui/icons/central/IconSignalTower';
import { IconSparklesTwo } from '@mastra/playground-ui/icons/central/IconSparklesTwo';
import { WorkflowIcon } from '@mastra/playground-ui/icons/WorkflowIcon';
import { t as studioT } from '@mastra/playground-ui/lib/i18n';
import { toast } from '@mastra/playground-ui/utils/toast';
import {
  useAgent,
  useReorderModelList,
  useUpdateModelInModelList,
  useChannelPlatforms,
} from '@mastra/react/hooks/agents';
import type { ComponentProps } from 'react';
import { useWatch } from 'react-hook-form';
import { AgentChannels } from '../agent-channels/agent-channels';
import {
  AgentMetadataBrowserToolsList,
  AgentMetadataCombinedProcessorList,
  AgentMetadataNetworkList,
  AgentMetadataScorerList,
  AgentMetadataSkillList,
  AgentMetadataToolList,
  AgentMetadataWorkflowList,
} from '../agent-metadata/agent-metadata-lists';
import { AgentMetadataModelList } from '../agent-metadata/agent-metadata-model-list';
import type { AgentEditFormContextValue } from '@/domains/agents/context/agent-edit-form-context';
import { useOptionalAgentEditFormContext } from '@/domains/agents/context/agent-edit-form-context';
import { getEditorOwnership } from '@/domains/agents/utils/editor-ownership';
import { useIsCmsAvailable } from '@/domains/cms/hooks/use-is-cms-available';
import { useRouteSidePanel } from '@/lib/route-side-panel';

export interface AgentOverviewPanelProps {
  agentId: string;
}

export function AgentOverviewPanel({ agentId }: AgentOverviewPanelProps) {
  const { isCollapsed } = useRouteSidePanel();

  return <AgentConfigSurface>{!isCollapsed && <AgentOverviewSections agentId={agentId} />}</AgentConfigSurface>;
}

type ModelListProps = ComponentProps<typeof AgentMetadataModelList>;

function EditorOwnedModelList({
  modelList,
  editable,
  readOnly,
  form,
}: Pick<ModelListProps, 'modelList' | 'editable' | 'readOnly'> & Pick<AgentEditFormContextValue, 'form'>) {
  const formModelList = useWatch({ control: form.control, name: 'modelList' });

  const reorderModelList: NonNullable<ModelListProps['reorderModelList']> = async params => {
    const currentList = form.getValues('modelList') ?? [];
    const entriesById = new Map(currentList.map(entry => [entry.id, entry]));
    form.setValue(
      'modelList',
      params.reorderedModelIds.flatMap(id => {
        const entry = entriesById.get(id);
        return entry ? [entry] : [];
      }),
      { shouldDirty: true },
    );
    return { message: studioT('Model list reordered') };
  };

  const updateModelInModelList: NonNullable<ModelListProps['updateModelInModelList']> = async params => {
    const currentList = form.getValues('modelList') ?? [];
    form.setValue(
      'modelList',
      currentList.map(entry =>
        entry.id === params.modelConfigId
          ? {
              ...entry,
              enabled: params.enabled ?? entry.enabled,
              maxRetries: params.maxRetries ?? entry.maxRetries,
              model: {
                ...entry.model,
                provider: params.model?.provider ?? entry.model.provider,
                modelId: params.model?.modelId ?? entry.model.modelId,
              },
            }
          : entry,
      ),
      { shouldDirty: true },
    );
    return { message: studioT('Model updated') };
  };

  return (
    <AgentMetadataModelList
      modelList={formModelList ?? modelList}
      editable={editable}
      readOnly={readOnly}
      updateModelInModelList={updateModelInModelList}
      reorderModelList={reorderModelList}
    />
  );
}

function AgentOverviewSections({ agentId }: AgentOverviewPanelProps) {
  const editFormContext = useOptionalAgentEditFormContext();
  const { data: agent, isLoading } = useAgent({
    agentId: agentId,
    version: { status: 'draft' },
    requestContext: useEntityRequestContext('agent', agentId)[0],
    queryOptions: { enabled: Boolean(agentId) },
  });
  const { mutateAsync: reorderModelList } = useReorderModelList({ agentId: agentId });
  const { mutateAsync: updateModelInModelList } = useUpdateModelInModelList({ agentId: agentId });
  const { isCmsAvailable, isLoading: isCmsLoading } = useIsCmsAvailable();
  const ownsModel = getEditorOwnership(
    editFormContext?.isCodeAgentOverride ?? false,
    editFormContext?.editorConfig,
  ).ownsModel;

  const reportModelListError = (error: Error & { body?: { error?: string } }) => {
    toast.error(error.body?.error || error.message || studioT('Failed to update model list'));
  };

  const handleReorderModelList = async (params: Parameters<typeof reorderModelList>[0]) => {
    try {
      return await reorderModelList(params);
    } catch (error) {
      reportModelListError(error as Error & { body?: { error?: string } });
      throw error;
    }
  };

  const handleUpdateModelInModelList = async (params: Parameters<typeof updateModelInModelList>[0]) => {
    try {
      return await updateModelInModelList(params);
    } catch (error) {
      reportModelListError(error as Error & { body?: { error?: string } });
      throw error;
    }
  };

  const { data: channelPlatforms } = useChannelPlatforms();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4" data-testid="agent-overview-panel-skeleton">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-16" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (!agent) {
    return (
      <Txt variant="body" tone="muted" className="p-4">
        {studioT('Agent not found')}
      </Txt>
    );
  }

  const networkAgentsMap = agent.agents ?? {};
  const networkAgents = Object.keys(networkAgentsMap).map(key => ({ ...networkAgentsMap[key], id: key }));
  const agentTools = agent.tools ?? {};
  const tools = Object.keys(agentTools).map(key => agentTools[key]);
  const agentWorkflows = agent.workflows ?? {};
  const workflows = Object.keys(agentWorkflows).map(key => ({ id: key, ...agentWorkflows[key] }));
  const skills = agent.skills ?? [];
  const workspaceTools = agent.workspaceTools ?? [];
  const browserTools = agent.browserTools ?? [];
  const inputProcessors = agent.inputProcessors ?? [];
  const outputProcessors = agent.outputProcessors ?? [];
  const hasChannels = Boolean(channelPlatforms?.length);

  return (
    <>
      {agent.modelList && (
        <AgentMetadataSection
          title={studioT('Models')}
          accent="blue"
          icon={<IconBox2 />}
          actions={editFormContext?.readOnly ? <Badge variant="warning">{studioT('Read-only')}</Badge> : undefined}
        >
          {ownsModel && editFormContext ? (
            <EditorOwnedModelList
              modelList={agent.modelList}
              editable={agent.modelListEditable !== false}
              readOnly={editFormContext.readOnly}
              form={editFormContext.form}
            />
          ) : (
            <AgentMetadataModelList
              modelList={agent.modelList}
              editable={agent.modelListEditable !== false}
              updateModelInModelList={handleUpdateModelInModelList}
              reorderModelList={handleReorderModelList}
            />
          )}
        </AgentMetadataSection>
      )}

      {networkAgents.length > 0 && (
        <AgentMetadataSection
          title={studioT('Agents')}
          count={networkAgents.length}
          accent="green"
          icon={<AgentIcon />}
          hint={{ link: 'https://mastra.ai/en/docs/agents/overview', title: studioT('Agents documentation') }}
        >
          <AgentMetadataNetworkList agents={networkAgents} />
        </AgentMetadataSection>
      )}

      <AgentMetadataSection
        title={studioT('Tools')}
        count={tools.length}
        accent="amber"
        icon={<IconMaintenance />}
        hint={{
          link: 'https://mastra.ai/en/docs/agents/using-tools-and-mcp',
          title: studioT('Using Tools and MCP documentation'),
        }}
      >
        <AgentMetadataToolList agentId={agentId} tools={tools} />
      </AgentMetadataSection>

      <AgentMetadataSection
        title={studioT('Workflows')}
        count={workflows.length}
        accent="blue"
        icon={<WorkflowIcon />}
        hint={{ link: 'https://mastra.ai/en/docs/workflows/overview', title: studioT('Workflows documentation') }}
      >
        <AgentMetadataWorkflowList workflows={workflows} />
      </AgentMetadataSection>

      {workspaceTools.length > 0 && (
        <AgentMetadataSection
          title={studioT('Workspace Tools')}
          count={workspaceTools.length}
          accent="green"
          icon={<IconFolder1 />}
          hint={{
            link: 'https://mastra.ai/en/reference/workspace/workspace-class#agent-tools',
            title: studioT('Workspace tools documentation'),
          }}
        >
          <AgentMetadataWorkspaceToolsList tools={workspaceTools} />
        </AgentMetadataSection>
      )}

      {browserTools.length > 0 && (
        <AgentMetadataSection
          title={studioT('Browser Tools')}
          count={browserTools.length}
          accent="cyan"
          icon={<IconGlobe />}
          hint={{
            link: 'https://mastra.ai/en/docs/agents/adding-browser-control',
            title: studioT('Browser tools documentation'),
          }}
        >
          <AgentMetadataBrowserToolsList tools={browserTools} />
        </AgentMetadataSection>
      )}

      {(inputProcessors.length > 0 || outputProcessors.length > 0) && (
        <AgentMetadataSection
          title={studioT('Processors')}
          accent="orange"
          icon={<IconChip />}
          hint={{ link: 'https://mastra.ai/docs/agents/processors', title: studioT('Processors documentation') }}
        >
          <AgentMetadataCombinedProcessorList inputProcessors={inputProcessors} outputProcessors={outputProcessors} />
        </AgentMetadataSection>
      )}

      <AgentMetadataSection
        title={studioT('Skills')}
        count={skills.length}
        accent="purple"
        icon={<IconSparklesTwo />}
        hint={{ link: 'https://mastra.ai/en/docs/workspace/skills', title: studioT('Skills documentation') }}
      >
        <AgentMetadataSkillList skills={skills} agentId={agentId} workspaceId={agent.workspaceId} />
      </AgentMetadataSection>

      <AgentMetadataSection title={studioT('Scorers')} accent="pink" icon={<IconGauge />}>
        <AgentMetadataScorerList entityId={agent.name} entityType="AGENT" />
      </AgentMetadataSection>
      <AgentMetadataSection title={studioT('Memory')} accent="purple" icon={<IconBrain />}>
        <AgentMemoryConfig agentId={agentId} />
      </AgentMetadataSection>

      {hasChannels && (
        <AgentMetadataSection title={studioT('Channels')} accent="cyan" icon={<IconSignalTower />}>
          <AgentChannels agentId={agentId} />
        </AgentMetadataSection>
      )}

      <AgentSystemPrompt instructions={extractPrompt(agent.instructions)}>
        {!isCmsLoading && !isCmsAvailable && (
          <Notice variant="warning" title={studioT('Read-only')}>
            <Notice.Message>
              {studioT('To edit the system prompt in Altflow, add') + ' '}
              <InlineCode>@mastra/editor</InlineCode>
              {' ' + studioT('to your project. See the')}{' '}
              <a
                href="https://mastra.ai/docs/editor/overview"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {studioT('documentation')}
              </a>
              .
            </Notice.Message>
          </Notice>
        )}
      </AgentSystemPrompt>
    </>
  );
}
