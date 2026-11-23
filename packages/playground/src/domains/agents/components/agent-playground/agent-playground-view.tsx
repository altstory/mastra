import { Txt } from '@mastra/playground-ui/components/Txt';
import { SidebarPanel } from '@mastra/playground-ui/domains/agents/chat/sidebar-panel';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { AgentPlaygroundConfig } from './agent-playground-config';
import { AgentPlaygroundVersionBar } from './agent-playground-version-bar';

interface AgentPlaygroundViewProps {
  agentId: string;
  activeVersionId?: string;
  selectedVersionId?: string;
  latestVersionId?: string;
  onVersionSelect: (versionId: string) => void;
  isDirty: boolean;
  isSavingDraft: boolean;
  isPublishing: boolean;
  hasDraft: boolean;
  readOnly: boolean;
  isCodeSourceAgent?: boolean;
  showCodeModeActions?: boolean;
  canOpenPr?: boolean;
  openPrTitle?: string;
  onSaveDraft: (changeMessage?: string) => Promise<void>;
  onPublish: () => Promise<void>;
  onDownloadJson?: () => Promise<void>;
  onOpenPr?: () => Promise<void>;
  isViewingPreviousVersion?: boolean;
}

export function AgentPlaygroundView({
  agentId,
  activeVersionId,
  selectedVersionId,
  latestVersionId,
  onVersionSelect,
  isDirty,
  isSavingDraft,
  isPublishing,
  hasDraft,
  readOnly,
  isCodeSourceAgent,
  showCodeModeActions,
  canOpenPr,
  openPrTitle,
  onSaveDraft,
  onPublish,
  onDownloadJson,
  onOpenPr,
  isViewingPreviousVersion,
}: AgentPlaygroundViewProps) {
  useLocale();
  const { versionSelector, actionBar } = AgentPlaygroundVersionBar({
    agentId,
    activeVersionId,
    selectedVersionId,
    onVersionSelect,
    isDirty,
    isSavingDraft,
    isPublishing,
    hasDraft,
    readOnly,
    isCodeSourceAgent,
    showCodeModeActions,
    canOpenPr,
    openPrTitle,
    onSaveDraft,
    onPublish,
    onDownloadJson,
    onOpenPr,
    isViewingPreviousVersion,
  });

  return (
    <SidebarPanel>
      {versionSelector}

      <div className="px-4 pt-3">
        <Txt variant="caption" tone="muted">
          {studioT("Edit your agent's system prompt, tools, and variables below.")}
        </Txt>
      </div>

      <div className="min-h-0 flex-1">
        <AgentPlaygroundConfig
          agentId={agentId}
          selectedVersionId={selectedVersionId}
          latestVersionId={latestVersionId}
        />
      </div>

      {actionBar}
    </SidebarPanel>
  );
}
