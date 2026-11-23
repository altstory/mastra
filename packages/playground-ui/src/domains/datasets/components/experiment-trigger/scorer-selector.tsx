import { useScorers } from '@/domains/scores/hooks';
import { Combobox } from '@/ds/components/Combobox';
import { Field, FieldDescription, FieldLabel } from '@/ds/components/Field';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface ScorerSelectorProps {
  selectedScorers: string[];
  setSelectedScorers: (scorers: string[]) => void;
  disabled?: boolean;
  container?: React.RefObject<HTMLElement | null>;
  label?: React.ReactNode;
  helperText?: string;
}

export function ScorerSelector({
  selectedScorers,
  setSelectedScorers,
  disabled = false,
  container,
  label = studioT('Scorers (Optional)'),
  helperText,
}: ScorerSelectorProps) {
  useLocale();
  const { data: scorers, isLoading } = useScorers();
  const options = Object.entries(scorers ?? {})
    .filter(([, scorer]) => scorer.isRegistered)
    .map(([id, scorer]) => ({
      value: id,
      label: scorer.scorer?.config?.name || id,
      description: scorer.scorer?.config?.description || '',
    }));

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Combobox
        multiple
        options={options}
        value={selectedScorers}
        onValueChange={setSelectedScorers}
        placeholder={studioT('Select scorers')}
        searchPlaceholder={studioT('Search scorers')}
        emptyText={studioT('No scorers available')}
        disabled={disabled || isLoading}
        container={container}
      />
      {helperText && <FieldDescription>{helperText}</FieldDescription>}
    </Field>
  );
}
