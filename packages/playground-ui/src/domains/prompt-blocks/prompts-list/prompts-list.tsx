import type { StoredPromptBlockResponse } from '@mastra/client-js';
import { useMemo } from 'react';
import { DataList, DataListSkeleton, useDataListKeyboard } from '@/ds/components/DataList';
import type { DataListSort } from '@/ds/components/DataList';
import { IconCheckmark2Medium } from '@/ds/icons/central/IconCheckmark2Medium';
import { useLinkComponent } from '@/lib/framework';
import { t as studioT, useLocale } from '@/lib/i18n';
import { truncateString } from '@/utils/truncate-string';

export interface PromptsListProps {
  promptBlocks: StoredPromptBlockResponse[];
  isLoading: boolean;
  search?: string;
  currentPage?: number;
  hasMore?: boolean;
  onNextPage?: () => void;
  onPrevPage?: () => void;
  updatedSort?: DataListSort;
  onSortChange?: (sort: DataListSort, key: string) => void;
}

const COLUMNS = 'auto 1fr auto auto auto';

export function PromptsList({
  promptBlocks,
  isLoading,
  search = '',
  currentPage,
  hasMore,
  onNextPage,
  onPrevPage,
  updatedSort,
  onSortChange,
}: PromptsListProps) {
  useLocale();
  const { paths, Link } = useLinkComponent();

  const filteredData = useMemo(() => {
    const term = search.toLowerCase();
    return promptBlocks.filter(
      block => block.name?.toLowerCase().includes(term) || block.description?.toLowerCase().includes(term),
    );
  }, [promptBlocks, search]);

  const { containerRef, getRowProps } = useDataListKeyboard({ count: filteredData.length, global: true });

  if (isLoading) {
    return <DataListSkeleton columns={COLUMNS} />;
  }

  return (
    <DataList columns={COLUMNS} scrollRef={containerRef}>
      <DataList.Top>
        <DataList.TopCell>{studioT('Name')}</DataList.TopCell>
        <DataList.TopCell>{studioT('Description')}</DataList.TopCell>
        <DataList.TopCell className="text-center">{studioT('Has Draft')}</DataList.TopCell>
        <DataList.TopCell className="text-center">{studioT('Is Published')}</DataList.TopCell>
        {onSortChange ? (
          <DataList.SortableTopCell sortKey="updatedAt" sort={updatedSort} onSortChange={onSortChange}>
            {studioT('Updated')}
          </DataList.SortableTopCell>
        ) : (
          <DataList.TopCell>{studioT('Updated')}</DataList.TopCell>
        )}
      </DataList.Top>

      {filteredData.length === 0 && search ? (
        <DataList.NoMatch message={studioT('No Prompts match your search')} />
      ) : null}

      {filteredData.map((block, index) => {
        const name = truncateString(block.name, 50);
        const description = truncateString(block.description ?? '', 200);

        return (
          <DataList.RowLink
            key={block.id}
            to={paths.cmsPromptBlockEditLink(block.id)}
            LinkComponent={Link}
            {...getRowProps(index)}
          >
            <DataList.NameCell>{name}</DataList.NameCell>
            <DataList.DescriptionCell>{description}</DataList.DescriptionCell>
            <DataList.TextCell className="text-center">
              {(block.hasDraft || !block.activeVersionId) && <IconCheckmark2Medium className="mx-auto size-icon-md" />}
            </DataList.TextCell>
            <DataList.TextCell className="text-center">
              {block.activeVersionId && <IconCheckmark2Medium className="mx-auto size-icon-md" />}
            </DataList.TextCell>
            <DataList.DateCell timestamp={block.updatedAt} />
          </DataList.RowLink>
        );
      })}

      <DataList.Pagination
        currentPage={currentPage}
        hasMore={hasMore}
        onNextPage={onNextPage}
        onPrevPage={onPrevPage}
      />
    </DataList>
  );
}
