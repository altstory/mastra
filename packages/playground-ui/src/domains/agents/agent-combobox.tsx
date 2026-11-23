import { useAgents } from '@mastra/react/hooks/agents';
import { useEffect } from 'react';
import { Combobox } from '@/ds/components/Combobox';
import type { ComboboxProps } from '@/ds/components/Combobox';
import { useLinkComponent } from '@/lib/framework';
import { t as studioT, useLocale } from '@/lib/i18n';
import { toast } from '@/utils/toast';

export interface AgentComboboxProps {
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  variant?: ComboboxProps['variant'];
  size?: ComboboxProps['size'];
  popupWidth?: ComboboxProps['popupWidth'];
  'aria-label'?: string;
  align?: ComboboxProps['align'];
}

export function AgentCombobox({
  value,
  onValueChange,
  placeholder = studioT('Select an agent'),
  searchPlaceholder = studioT('Search agents'),
  emptyText = studioT('No agents found.'),
  className,
  disabled = false,
  variant,
  size,
  popupWidth,
  'aria-label': ariaLabel,
  align,
}: AgentComboboxProps) {
  const studioLocale = useLocale();
  const { data: agents = {}, isLoading, isError, error } = useAgents();
  const { navigate, paths } = useLinkComponent();

  useEffect(() => {
    if (isError) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load agents';
      toast.error(studioT('Error loading agents: {value0}', { value0: errorMessage }));
    }
  }, [isError, error, studioLocale]);

  const agentOptions = Object.keys(agents).map(key => ({
    label: agents[key]?.name || key,
    value: key,
  }));

  const handleValueChange = (newAgentId: string) => {
    if (onValueChange) {
      onValueChange(newAgentId);
    } else if (newAgentId && newAgentId !== value) {
      navigate(paths.agentLink(newAgentId));
    }
  };

  return (
    <Combobox
      options={agentOptions}
      value={value}
      onValueChange={handleValueChange}
      placeholder={isLoading ? studioT('Loading agents...') : placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      className={className}
      disabled={disabled || isLoading || isError}
      variant={variant}
      size={size}
      popupWidth={popupWidth}
      aria-label={ariaLabel}
      align={align}
    />
  );
}
