import type { McpServerInfo, McpServerTask } from '@mastra/client-js';
import { ActionRow } from '@mastra/playground-ui/components/ActionRow';
import { Button } from '@mastra/playground-ui/components/Button';
import { DataList, DataListSkeleton, useDataListKeyboard } from '@mastra/playground-ui/components/DataList';
import { FilterBar } from '@mastra/playground-ui/components/FilterBar';
import type { FilterBarField, FilterBarItem, FilterBarOperator } from '@mastra/playground-ui/components/FilterBar';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { RelativeTimestamp } from '@mastra/playground-ui/components/RelativeTimestamp';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { IconCircleCheck } from '@mastra/playground-ui/icons/central/IconCircleCheck';
import { IconMaintenance } from '@mastra/playground-ui/icons/central/IconMaintenance';
import { IconUser } from '@mastra/playground-ui/icons/central/IconUser';
import { useLinkComponent } from '@mastra/playground-ui/lib/framework';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { Trans } from '@mastra/playground-ui/lib/i18n/trans';
import { hueAccentColor } from '@mastra/playground-ui/utils/colors';
import { useMemo, useRef, useState } from 'react';
import type { FormEvent, SyntheticEvent } from 'react';
import { useSearchParams } from 'react-router';
import {
  TASK_STATUS_LABELS,
  useFindMcpServerTask,
  useMcpServerTaskSurfaces,
  useMcpServerTasks,
} from '../hooks/use-mcp-server-tasks';
import type { McpTaskFilters } from '../hooks/use-mcp-server-tasks';
import {
  shortClientKey,
  shortTaskKey,
  taskSearch,
  useTaskDrawerParam,
  useTaskFilters,
} from '../hooks/use-task-drawer-param';
import { McpTaskStatusBadge } from './mcp-task-drawer/mcp-task-status-badge';

const COLUMNS = 'minmax(0,1fr) auto auto auto auto auto auto auto';

const UNAVAILABLE = {
  not_listable: "This server's task store can't be listed.",
  resource_scoped: 'The task list needs a Altflow session that is not scoped to a resource.',
} as const;

const OPERATORS: FilterBarOperator[] = [
  {
    id: 'is',
    get label() {
      return studioT('is');
    },
  },
];

const STATUS_OPTIONS = Object.entries(TASK_STATUS_LABELS).map(([value, label]) => ({ value, label }));

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

/** The client's readable label, or a short form of its key for tasks stored without one. */
const clientName = (task: McpServerTask) => task.clientLabel ?? shortClientKey(task.principalKey);

const toItems = (filters: McpTaskFilters): FilterBarItem[] =>
  (['status', 'surface', 'client'] as const).flatMap(fieldId => {
    const value = filters[fieldId];
    return value ? [{ id: fieldId, fieldId, operatorId: 'is', value }] : [];
  });

const fromItems = (items: FilterBarItem[]): McpTaskFilters => {
  const valueOf = (fieldId: string) => {
    const value = items.find(item => item.fieldId === fieldId)?.value;
    return typeof value === 'string' && value ? value : undefined;
  };
  return {
    status: valueOf('status') as McpTaskFilters['status'],
    surface: valueOf('surface'),
    client: valueOf('client'),
  };
};

/**
 * The server's MCP tasks, newest first, across the clients that started them. Render it only
 * for servers that report `tasks_capability`.
 */
export function McpServerTasksList({ server }: { server: McpServerInfo }) {
  const studioLocale = useLocale();
  const { filters, setFilters } = useTaskFilters();
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useMcpServerTasks(
    server.id,
    filters,
  );
  const { data: surfaces = [] } = useMcpServerTaskSurfaces(server.id);
  const tasks = useMemo(() => data?.pages.flatMap(page => page.tasks) ?? [], [data]);
  const unavailable = data?.pages[0]?.unavailable;
  const { containerRef, getRowProps } = useDataListKeyboard({ count: tasks.length });
  const filtered = toItems(filters).length > 0;

  // Clients in the loaded tasks, plus the filtered one, for the client filter's suggestions. The
  // filter matches the client key exactly; the label is what the chip shows.
  const clients = useMemo(() => {
    const names = new Map(tasks.map(task => [task.principalKey, clientName(task)]));
    if (filters.client && !names.has(filters.client)) names.set(filters.client, shortClientKey(filters.client));
    return [...names];
  }, [tasks, filters.client]);

  const fields = useMemo<FilterBarField[]>(
    () => [
      {
        id: 'status',
        label: studioT('Status'),
        icon: IconCircleCheck,
        color: hueAccentColor('orange'),
        operators: ['is'],
        strict: true,
        suggestions: STATUS_OPTIONS,
      },
      {
        id: 'surface',
        label: studioT('Surface'),
        icon: IconMaintenance,
        color: hueAccentColor('blue'),
        operators: ['is'],
        strict: true,
        suggestions: surfaces.map(surface => ({ value: surface.name })),
      },
      {
        id: 'client',
        label: studioT('Client'),
        icon: IconUser,
        color: hueAccentColor('purple'),
        operators: ['is'],
        suggestions: clients.map(([value, label]) => ({ value, label })),
      },
    ],
    [surfaces, clients, studioLocale],
  );

  return (
    <section aria-label={studioT('Tasks')} className="flex flex-col gap-3">
      <Txt as="h2" variant="heading">
        {studioT('Tasks')}
      </Txt>

      {isError && <Notice variant="destructive">{studioT("Could not load this server's tasks.")}</Notice>}
      {unavailable && <Notice variant="info">{UNAVAILABLE[unavailable]}</Notice>}

      {!unavailable && (
        <ActionRow>
          <ActionRow.Start>
            <FilterBar
              fields={fields}
              operators={OPERATORS}
              value={toItems(filters)}
              onValueChange={(items: FilterBarItem[]) => setFilters(fromItems(items))}
              createItemId={fieldId => fieldId}
              aria-label={studioT('Task filters')}
              className="min-w-64 flex-1"
            >
              <FilterBar.Chips />
              <FilterBar.Input placeholder={studioT('Filter tasks')} />
            </FilterBar>
          </ActionRow.Start>
          <ActionRow.End>
            <FindTaskById serverId={server.id} />
          </ActionRow.End>
        </ActionRow>
      )}

      {isLoading && <DataListSkeleton columns={COLUMNS} />}
      {data && !unavailable && (
        <DataList columns={COLUMNS} scrollRef={containerRef}>
          <DataList.Top>
            <DataList.TopCell>{studioT('Surface')}</DataList.TopCell>
            <DataList.TopCell>{studioT('Status')}</DataList.TopCell>
            <DataList.TopCell>{studioT('Created')}</DataList.TopCell>
            <DataList.TopCell>{studioT('Updated')}</DataList.TopCell>
            <DataList.TopCell>{studioT('Expires')}</DataList.TopCell>
            <DataList.TopCell>{studioT('Inputs')}</DataList.TopCell>
            <DataList.TopCell>{studioT('Key')}</DataList.TopCell>
            <DataList.TopCell>{studioT('Client')}</DataList.TopCell>
          </DataList.Top>

          {tasks.length === 0 && (
            <DataList.NoMatch message={filtered ? studioT('No tasks match these filters') : studioT('No tasks yet')} />
          )}

          {tasks.map((task, index) => (
            <McpTaskRow
              key={task.taskKey}
              serverId={server.id}
              task={task}
              rowProps={getRowProps(index)}
              onFilterClient={() => setFilters({ ...filters, client: task.principalKey })}
            />
          ))}
        </DataList>
      )}

      {hasNextPage && (
        <div className="flex items-center gap-3">
          <Button variant="default" size="sm" onClick={() => fetchNextPage()} loading={isFetchingNextPage}>
            {studioT('Load more')}
          </Button>
          <Txt variant="caption" tone="muted">
            <Trans
              id="Showing the {part0} most recent {part1} tasks."
              values={{ part0: tasks.length, part1: filtered ? studioT('matching') + ' ' : '' }}
            />
          </Txt>
        </div>
      )}
    </section>
  );
}

function McpTaskRow({
  serverId,
  task,
  rowProps,
  onFilterClient,
}: {
  serverId: string;
  task: McpServerTask;
  rowProps: ReturnType<ReturnType<typeof useDataListKeyboard>['getRowProps']>;
  onFilterClient: () => void;
}) {
  useLocale();
  const { Link } = useLinkComponent();
  const [params] = useSearchParams();
  const linkRef = useRef<HTMLAnchorElement>(null);

  return (
    <DataList.RowWrapper {...rowProps} onSelectRow={() => linkRef.current?.click()}>
      <DataList.RowLink
        ref={linkRef}
        colEnd={-2}
        to={`/mcps/${serverId}${taskSearch(task.taskKey, params)}`}
        LinkComponent={Link}
        tabIndex={-1}
        onClick={stopPropagation}
        aria-label={studioT('{value0} task {value1}', { value0: task.surface, value1: shortTaskKey(task.taskKey) })}
      >
        <DataList.NameCell>{task.surface}</DataList.NameCell>
        <DataList.Cell>
          <McpTaskStatusBadge status={task.status} />
        </DataList.Cell>
        <DataList.CreatedCell timestamp={task.createdAt} preset="day-time-seconds" />
        <DataList.Cell className="text-muted-foreground">
          <RelativeTimestamp value={task.lastUpdatedAt} />
        </DataList.Cell>
        <DataList.Cell className="text-muted-foreground">
          {task.expiresAt ? <RelativeTimestamp value={task.expiresAt} /> : studioT('never')}
        </DataList.Cell>
        <DataList.TextCell>{Object.keys(task.inputRequests ?? {}).length || '—'}</DataList.TextCell>
        <DataList.TextCell font="mono" className="text-muted-foreground">
          {shortTaskKey(task.taskKey)}
        </DataList.TextCell>
      </DataList.RowLink>
      <DataList.Cell className="pr-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start font-mono"
          tooltip={studioT("Show only this client's tasks")}
          aria-label={studioT('Show only tasks from client {value0}', { value0: clientName(task) })}
          onClick={event => {
            event.stopPropagation();
            onFilterClient();
          }}
        >
          {clientName(task)}
        </Button>
      </DataList.Cell>
    </DataList.RowWrapper>
  );
}

/** Opens a task from the MCP task id a client sees, such as the one in a tool-call card. */
function FindTaskById({ serverId }: { serverId: string }) {
  useLocale();
  const [taskId, setTaskId] = useState('');
  const find = useFindMcpServerTask(serverId);
  const { open } = useTaskDrawerParam();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = taskId.trim();
    if (!id) return;
    find.mutate(id, {
      onSuccess: ({ task }) => {
        setTaskId('');
        open(task.taskKey);
      },
    });
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2" aria-label={studioT('Find a task by MCP task id')}>
      <Input
        size="sm"
        value={taskId}
        onChange={event => {
          setTaskId(event.target.value);
          find.reset();
        }}
        placeholder={studioT('MCP task id')}
        aria-label={studioT('MCP task id')}
        aria-invalid={find.isError || undefined}
        className="w-56 font-mono"
      />
      <Button type="submit" size="sm" variant="default" disabled={!taskId.trim()} loading={find.isPending}>
        {studioT('Find')}
      </Button>
      {find.isError && (
        <Txt variant="caption" role="status" className="text-destructive-foreground">
          {studioT('No task with that id.')}
        </Txt>
      )}
    </form>
  );
}
