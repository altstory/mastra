import { SkillSaveButton } from './skill-save-button';
import { SkillSimpleForm } from './skill-simple-form';
import type { SkillSimpleFormProps } from './skill-simple-form';
import { Button } from '@/ds/components/Button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/ds/components/Drawer';
import { Notice } from '@/ds/components/Notice';
import { t as studioT } from '@/lib/i18n';

export function SkillCreateDialog({
  fields,
  pending,
  error,
  onClose,
  onCreate,
  editing = false,
}: {
  fields: SkillSimpleFormProps;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onCreate: () => void;
  editing?: boolean;
}) {
  return (
    <Drawer open side="right" variant="floating" onOpenChange={open => !open && !pending && onClose()}>
      <DrawerContent className="w-xl max-w-full" aria-busy={pending}>
        <DrawerHeader>
          <DrawerTitle>{editing ? studioT('Edit skill') : studioT('Create skill')}</DrawerTitle>
          <DrawerDescription>
            {editing
              ? studioT('Changes apply to all agents using the latest version of this project skill.')
              : studioT('Describe what your skill should do.')}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <SkillSimpleForm {...fields} />
          {error && <Notice variant="warning" title={error} role="alert" />}
        </DrawerBody>
        <DrawerFooter>
          <Button type="button" disabled={pending} onClick={onClose}>
            {studioT('Cancel')}
          </Button>
          <SkillSaveButton
            editing={editing}
            disabled={!fields.name.trim() || !fields.instructions.trim()}
            pending={pending}
            onSave={onCreate}
          />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
