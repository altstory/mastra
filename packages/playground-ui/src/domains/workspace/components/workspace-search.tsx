import { useWorkspaceSearch } from '@mastra/react/hooks/workspace';
import { useState, useTransition } from 'react';
import { useWorkspaceContext } from './use-workspace-context';
import { WorkspaceError } from './workspace-error';
import { Button } from '@/ds/components/Button';
import { EmptyState } from '@/ds/components/EmptyState';
import { Input } from '@/ds/components/Input';
import { Metadata } from '@/ds/components/Metadata';
import { Skeleton } from '@/ds/components/Skeleton';
import { Txt } from '@/ds/components/Txt';
import { FileIcon, Icon, SearchIcon, SkillIcon } from '@/ds/icons';
import { IconCrossMedium } from '@/ds/icons/central/IconCrossMedium';

import { t as studioT, useLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Icon button that swaps the tree for the search panel, like VS Code's search view. */
export function WorkspaceSearchToggle() {
  useLocale();
  const { isSearching, setSearching, searchFiles, searchSkills } = useWorkspaceContext();
  if (!searchFiles && !searchSkills) return null;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      tooltip={studioT('Search files and skills')}
      aria-pressed={isSearching}
      onClick={() => setSearching(!isSearching)}
    >
      <SearchIcon />
    </Button>
  );
}

/** The search input while searching, the aside title otherwise. */
export function WorkspaceSearch() {
  const { isSearching } = useWorkspaceContext();
  return isSearching ? <SearchInput /> : <AsideTitle />;
}

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function AsideTitle() {
  useLocale();
  const { fileCount, skillCount } = useWorkspaceContext();
  return (
    <Txt as="span" variant="label" tone="muted" className="block min-w-0">
      <Metadata singleLine>
        <Metadata.Item>{fileCount === undefined ? studioT('Files') : countLabel(fileCount, 'File')}</Metadata.Item>
        {skillCount === undefined ? null : <Metadata.Item>{countLabel(skillCount, 'Skill')}</Metadata.Item>}
      </Metadata>
    </Txt>
  );
}

// Mounted only while searching, so reopening the search starts from an empty input.
function SearchInput() {
  useLocale();
  const { setSearching, setQuery } = useWorkspaceContext();
  const [value, setValue] = useState('');
  const [, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1">
      <Input
        type="search"
        size="sm"
        autoFocus
        aria-label={studioT('Search query')}
        placeholder={studioT('Search files and skills')}
        value={value}
        onChange={event => {
          const next = event.target.value;
          setValue(next);
          startTransition(() => setQuery(next));
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') setSearching(false);
        }}
      />
      <Button variant="ghost" size="icon-sm" tooltip={studioT('Close search')} onClick={() => setSearching(false)}>
        <IconCrossMedium />
      </Button>
    </div>
  );
}

export function WorkspaceSearchResults() {
  useLocale();
  const { workspaceId, query, activeFilePath, setActiveFilePath, searchFiles, searchSkills } = useWorkspaceContext();
  const { data, isLoading, isError, error } = useWorkspaceSearch({
    workspaceId: workspaceId,
    query: query,
    files: searchFiles,
    skills: searchSkills,
    queryOptions: { enabled: query.trim().length > 0 && (searchFiles || searchSkills) },
  });

  if (!query.trim()) {
    return (
      <EmptyState
        titleSlot={studioT('Search files and skills')}
        descriptionSlot={studioT('Type to find matching content.')}
      />
    );
  }
  if (isLoading) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2 p-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (isError) return <WorkspaceError error={error ?? undefined} fallback="Search failed." className="m-2" />;
  if (!data?.length) return <EmptyState titleSlot={studioT('No results')} />;

  return (
    <ul aria-label={studioT('Search results')} className="flex flex-col py-1">
      {data.map(hit => (
        <li key={hit.path}>
          <button
            type="button"
            aria-label={hit.path}
            onClick={() => setActiveFilePath(hit.path)}
            className={cn(
              'text-foreground',
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-fill-subtle',
              activeFilePath === hit.path && 'bg-fill',
            )}
          >
            <Icon size="sm">{hit.kind === 'skill' ? <SkillIcon /> : <FileIcon />}</Icon>
            <Txt as="span" variant="body-sm" className="truncate">
              {hit.label}
            </Txt>
          </button>
        </li>
      ))}
    </ul>
  );
}
