import { Fragment } from 'react';
import type { ComponentType, SVGProps } from 'react';
import { DataListCell, DataListTextCell } from '../data-list-cells';
import { Badge } from '@/ds/components/Badge';
import type { BadgeVariant } from '@/ds/components/Badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ds/components/Tooltip';
import { Txt } from '@/ds/components/Txt';
import { AgentIcon } from '@/ds/icons/AgentIcon';
import { IconArrowCornerDownRight } from '@/ds/icons/central/IconArrowCornerDownRight';
import { IconArrowSplitUp } from '@/ds/icons/central/IconArrowSplitUp';
import { IconCodeTree } from '@/ds/icons/central/IconCodeTree';
import { IconDirection1 } from '@/ds/icons/central/IconDirection1';
import { IconServer1 } from '@/ds/icons/central/IconServer1';
import { McpServerIcon } from '@/ds/icons/McpServerIcon';
import { MemoryIcon } from '@/ds/icons/MemoryIcon';
import { ProcessorIcon } from '@/ds/icons/ProcessorIcon';
import { ScorersIcon } from '@/ds/icons/ScorersIcon';
import { ToolsIcon } from '@/ds/icons/ToolsIcon';
import { WorkflowIcon } from '@/ds/icons/WorkflowIcon';

import { t as studioT, useLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// NameCell
// ---------------------------------------------------------------------------

export interface TracesDataListNameCellProps {
  name?: string | null;
  /** `null`/missing → root span (Trace). Set → nested span (Subtrace). Drives the leading level icon. */
  parentSpanId?: string | null;
  /** When true, the leading level icon is wrapped in a Trace/Subtrace tooltip. Off by default —
   *  only meaningful in branches mode, where rows mix root traces and subtraces. */
  showLevelTooltip?: boolean;
}

export function TracesDataListNameCell({ name, parentSpanId, showLevelTooltip }: TracesDataListNameCellProps) {
  const isRoot = parentSpanId == null;
  const Icon = isRoot ? IconCodeTree : IconArrowCornerDownRight;
  const label = isRoot ? 'Trace' : 'Subtrace';
  const icon = (
    <span aria-label={label} className="inline-flex shrink-0">
      <Icon
        className={cn('size-4 shrink-0', isRoot ? 'text-muted-foreground' : 'text-subtle-foreground')}
        aria-hidden
      />
    </span>
  );
  return (
    <DataListCell className="flex min-w-0 items-center gap-2 text-body-sm text-muted-foreground">
      {showLevelTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{icon}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        icon
      )}
      <span className="min-w-0 truncate">{name || '-'}</span>
    </DataListCell>
  );
}

// ---------------------------------------------------------------------------
// InputCell
// ---------------------------------------------------------------------------

export interface TracesDataListInputCellProps {
  input?: string | null;
}

export function TracesDataListInputCell({ input }: TracesDataListInputCellProps) {
  return <DataListTextCell font="mono">{input || '-'}</DataListTextCell>;
}

// ---------------------------------------------------------------------------
// OutputCell
// ---------------------------------------------------------------------------

export interface TracesDataListOutputCellProps {
  output?: string;
  /** Shown instead of `output`, in the error color, when `status` is `'error'`. */
  error?: string;
  status?: string | null;
}

export function TracesDataListOutputCell({ output, error, status }: TracesDataListOutputCellProps) {
  const failed = status === 'error';
  const errorColor = failed ? 'text-destructive-foreground' : undefined;
  return (
    <DataListTextCell font="mono" className={errorColor}>
      {(failed ? error : output) || '-'}
    </DataListTextCell>
  );
}

// ---------------------------------------------------------------------------
// TypeCell
// ---------------------------------------------------------------------------

type EntityTypeDisplay = { label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> };

// Keys are lowercase `EntityType` enum values (plus legacy `workflow`).
const ENTITY_TYPE_DISPLAY: Record<string, EntityTypeDisplay> = {
  agent: {
    get label() {
      return studioT('Agent');
    },
    Icon: AgentIcon,
  },
  workflow: {
    get label() {
      return studioT('Workflow');
    },
    Icon: WorkflowIcon,
  },
  workflow_run: {
    get label() {
      return studioT('Workflow');
    },
    Icon: WorkflowIcon,
  },
  workflow_step: {
    get label() {
      return studioT('Step');
    },
    Icon: WorkflowIcon,
  },
  tool: {
    get label() {
      return studioT('Tool');
    },
    Icon: ToolsIcon,
  },
  scorer: {
    get label() {
      return studioT('Scorer');
    },
    Icon: ScorersIcon,
  },
  classifier: {
    get label() {
      return studioT('Classifier');
    },
    Icon: IconArrowSplitUp,
  },
  memory: {
    get label() {
      return studioT('Memory');
    },
    Icon: MemoryIcon,
  },
  mcp_server: {
    get label() {
      return studioT('MCP Server');
    },
    Icon: McpServerIcon,
  },
  input_processor: {
    get label() {
      return studioT('Processor');
    },
    Icon: ProcessorIcon,
  },
  input_step_processor: {
    get label() {
      return studioT('Processor');
    },
    Icon: ProcessorIcon,
  },
  output_processor: {
    get label() {
      return studioT('Processor');
    },
    Icon: ProcessorIcon,
  },
  output_step_processor: {
    get label() {
      return studioT('Processor');
    },
    Icon: ProcessorIcon,
  },
  tool_result_processor: {
    get label() {
      return studioT('Processor');
    },
    Icon: ProcessorIcon,
  },
  rag_ingestion: {
    get label() {
      return studioT('RAG');
    },
    Icon: IconServer1,
  },
  trajectory: {
    get label() {
      return studioT('Trajectory');
    },
    Icon: IconDirection1,
  },
};

export interface TracesDataListTypeCellProps {
  entityType?: string | null;
}

export function TracesDataListTypeCell({ entityType }: TracesDataListTypeCellProps) {
  const display = entityType ? ENTITY_TYPE_DISPLAY[entityType.toLowerCase()] : undefined;

  return (
    <DataListCell className="flex min-w-0 items-center gap-2">
      {display ? (
        <>
          <display.Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
          <Txt as="span" variant="body-sm" className="min-w-0 truncate">
            {display.label}
          </Txt>
        </>
      ) : (
        '-'
      )}
    </DataListCell>
  );
}

// ---------------------------------------------------------------------------
// StatusCell
// ---------------------------------------------------------------------------

const UNSET_STATUS_CONFIG: { label: string; variant: BadgeVariant } = { label: '-', variant: 'neutral' };

const STATUS_CONFIG: Record<string, { label: string; variant: BadgeVariant }> = {
  completed: {
    get label() {
      return studioT('OK');
    },
    variant: 'success',
  },
  ok: {
    get label() {
      return studioT('OK');
    },
    variant: 'success',
  },
  success: {
    get label() {
      return studioT('OK');
    },
    variant: 'success',
  },
  error: {
    get label() {
      return studioT('ERR');
    },
    variant: 'destructive',
  },
  running: {
    get label() {
      return studioT('RUN');
    },
    variant: 'neutral',
  },
  unset: UNSET_STATUS_CONFIG,
};

export interface TracesDataListStatusCellProps {
  status?: string | null;
}

export function TracesDataListStatusCell({ status }: TracesDataListStatusCellProps) {
  const key = (status ?? 'unset').toLowerCase();
  const config = STATUS_CONFIG[key] ?? UNSET_STATUS_CONFIG;

  return (
    <DataListCell>
      <Badge size="xs" variant={config.variant}>
        {config.label}
      </Badge>
    </DataListCell>
  );
}

// ---------------------------------------------------------------------------
// OutcomeCell
// ---------------------------------------------------------------------------

const OUTCOME_CONFIG: Record<string, { label: string; variant: BadgeVariant }> = {
  success: {
    get label() {
      return studioT('OK');
    },
    variant: 'success',
  },
  error: {
    get label() {
      return studioT('ERR');
    },
    variant: 'destructive',
  },
  abort: {
    get label() {
      return studioT('Abort');
    },
    variant: 'warning',
  },
  interrupted: {
    get label() {
      return studioT('Interrupted');
    },
    variant: 'warning',
  },
  limit: {
    get label() {
      return studioT('Limit');
    },
    variant: 'orange',
  },
  blocked: {
    get label() {
      return studioT('Blocked');
    },
    variant: 'orange',
  },
  suspend: {
    get label() {
      return studioT('Suspend');
    },
    variant: 'info',
  },
  unknown: {
    get label() {
      return studioT('Unknown');
    },
    variant: 'neutral',
  },
};

const formatContextValue = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export interface TracesDataListOutcomeCellProps {
  outcome?: string | null;
  /** Error-based status, shown when no outcome was recorded. */
  status?: string | null;
}

export function TracesDataListOutcomeCell({ outcome, status }: TracesDataListOutcomeCellProps) {
  useLocale();
  if (!outcome) {
    const config = STATUS_CONFIG[(status ?? 'unset').toLowerCase()] ?? UNSET_STATUS_CONFIG;
    const badge = (
      <Badge size="xs" variant={config.variant}>
        {config.label}
      </Badge>
    );
    return (
      <DataListCell>
        {config === UNSET_STATUS_CONFIG ? (
          badge
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>{badge}</TooltipTrigger>
            <TooltipContent>{studioT('Outcome not recorded; status from error')}</TooltipContent>
          </Tooltip>
        )}
      </DataListCell>
    );
  }

  const config = OUTCOME_CONFIG[outcome.toLowerCase()] ?? { label: outcome, variant: 'neutral' };
  return (
    <DataListCell>
      <Badge size="xs" variant={config.variant}>
        {config.label}
      </Badge>
    </DataListCell>
  );
}

// ---------------------------------------------------------------------------
// StopReasonCell
// ---------------------------------------------------------------------------

export interface TracesDataListStopReasonCellProps {
  stopReason?: string | null;
  /** Listed as key/value pairs when hovering the stop reason. */
  stopReasonContext?: Record<string, unknown> | null;
}

export function TracesDataListStopReasonCell({ stopReason, stopReasonContext }: TracesDataListStopReasonCellProps) {
  // Empty, so DataListCell shows its own placeholder.
  if (!stopReason) return <DataListCell />;

  const contextEntries = stopReasonContext ? Object.entries(stopReasonContext) : [];
  if (contextEntries.length === 0) {
    return <DataListTextCell font="mono">{stopReason}</DataListTextCell>;
  }

  return (
    <DataListCell className="flex items-center">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex min-w-0" />}>
          <Txt as="span" variant="body-sm" tone="muted" font="mono" className="truncate">
            {stopReason}
          </Txt>
        </TooltipTrigger>
        <TooltipContent>
          {/* The cell can truncate long reasons like `context_window_exceeded`, so name it here too. */}
          <Txt as="p" variant="body-sm" font="mono" className="mb-1">
            {stopReason}
          </Txt>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {contextEntries.map(([key, value]) => (
              <Fragment key={key}>
                <dt>{key}</dt>
                <dd>{formatContextValue(value)}</dd>
              </Fragment>
            ))}
          </dl>
        </TooltipContent>
      </Tooltip>
    </DataListCell>
  );
}
