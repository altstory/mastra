import { Button } from '@/ds/components/Button';
import { IconCheckmark2Medium } from '@/ds/icons/central/IconCheckmark2Medium';
import { SkillIcon } from '@/ds/icons/SkillIcon';
import { t as studioT } from '@/lib/i18n';

export function SkillSaveButton({
  editing,
  disabled,
  pending,
  onSave,
}: {
  editing?: boolean;
  disabled: boolean;
  pending: boolean;
  onSave: () => void;
}) {
  return (
    <Button
      type="button"
      icon={editing ? <IconCheckmark2Medium /> : <SkillIcon />}
      variant="primary"
      size="sm"
      onClick={onSave}
      disabled={disabled || pending}
    >
      {pending ? studioT('Saving...') : editing ? studioT('Save') : studioT('Create')}
    </Button>
  );
}
