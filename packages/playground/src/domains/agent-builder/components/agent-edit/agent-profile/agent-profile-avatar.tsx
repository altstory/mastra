import { AgentAvatarUpload } from '@mastra/playground-ui/domains/agent-avatar';
import { useLocale } from '@mastra/playground-ui/lib/i18n';
import { useFormContext, useWatch } from 'react-hook-form';

import { useAgentColor } from '../../../contexts/agent-color-context';
import { useBuilderAgentFeatures } from '../../../hooks/use-builder-agent-features';
import type { AgentBuilderEditFormValues } from '../../../schemas';

export interface AgentProfileAvatarProps {
  disabled?: boolean;
}

export const AgentProfileAvatar = ({ disabled = false }: AgentProfileAvatarProps) => {
  useLocale();
  const features = useBuilderAgentFeatures();
  const { setValue, control } = useFormContext<AgentBuilderEditFormValues>();
  const draftName = useWatch({ control, name: 'name' }) ?? '';
  const draftAvatarUrl = useWatch({ control, name: 'avatarUrl' });
  const agentColor = useAgentColor();

  return (
    <AgentAvatarUpload
      className="scale-[1.65]"
      name={draftName}
      avatarUrl={draftAvatarUrl}
      disabled={disabled}
      onChange={features.avatarUpload ? dataUrl => setValue('avatarUrl', dataUrl, { shouldDirty: true }) : undefined}
      color={agentColor.background}
      textColor={agentColor.foreground}
    />
  );
};
