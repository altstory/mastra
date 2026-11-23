import { usePromptBlockVersions } from '@mastra/react/hooks/prompt-blocks';
import { Badge } from '@/ds/components/Badge';
import { Combobox } from '@/ds/components/Combobox';
import type { ComboboxProps } from '@/ds/components/Combobox';
import { t as studioT, useLocale } from '@/lib/i18n';
import { formatDate } from '@/utils/date-format';

export interface PromptBlockVersionComboboxProps {
  blockId: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  disabled?: boolean;
  variant?: ComboboxProps['variant'];
  activeVersionId?: string;
}

export function PromptBlockVersionCombobox({
  blockId,
  value,
  onValueChange,
  className,
  disabled = false,
  variant,
  activeVersionId,
}: PromptBlockVersionComboboxProps) {
  useLocale();
  const { data, isLoading } = usePromptBlockVersions({
    blockId,
    params: { orderBy: { direction: 'DESC' } },
    queryOptions: { enabled: !!blockId },
  });

  const versions = data?.versions ?? [];

  const activeVersion = activeVersionId ? versions.find(v => v.id === activeVersionId) : undefined;
  const activeVersionNumber = activeVersion?.versionNumber;

  const options = [
    { label: studioT('Latest'), value: '' },
    ...versions.map(version => {
      const isPublished = version.id === activeVersionId;
      const isDraft = activeVersionNumber !== undefined && version.versionNumber > activeVersionNumber;

      return {
        label: studioT('v{value0}', { value0: version.versionNumber }),
        value: version.id,
        description: formatDate(version.createdAt, 'date-time') ?? '',
        end: isPublished ? (
          <Badge variant="success">{studioT('Published')}</Badge>
        ) : isDraft ? (
          <Badge variant="info">{studioT('Draft')}</Badge>
        ) : undefined,
      };
    }),
  ];

  return (
    <Combobox
      options={options}
      value={value}
      onValueChange={onValueChange}
      placeholder={isLoading ? studioT('Loading versions...') : studioT('Versions')}
      searchPlaceholder={studioT('Search versions')}
      emptyText={studioT('No versions found.')}
      className={className}
      disabled={disabled || isLoading}
      variant={variant}
    />
  );
}
