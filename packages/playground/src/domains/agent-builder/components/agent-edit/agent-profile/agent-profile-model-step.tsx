import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { ProviderLogo, cleanProviderId } from '@mastra/playground-ui/domains/llm';
import { IconArrowRight } from '@mastra/playground-ui/icons/central/IconArrowRight';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useWatch } from 'react-hook-form';
import { AgentStepContainer } from './agent-step-container';
import { Models } from './models';
import { useStreamRunning } from '@/domains/agent-builder/contexts/stream-chat-context';
import { useWizard } from '@/domains/agent-builder/contexts/wizard-context';
import { startViewTransition } from '@/lib/routing';

interface ActiveModelBadgeProps {
  provider: string;
  name: string;
}
const ActiveModelBadge = ({ provider, name }: ActiveModelBadgeProps) => {
  const providerId = cleanProviderId(provider);
  return (
    <Badge>
      <ProviderLogo providerId={providerId} size={16} /> {providerId}/{name}
    </Badge>
  );
};

export const AgentProfileModelStep = () => {
  useLocale();
  const { next } = useWizard();
  const isStreaming = useStreamRunning();
  const model = useWatch({ name: 'model' });

  const handleContinue = () => {
    startViewTransition(() => {
      next();
    });
  };

  return (
    <AgentStepContainer
      title={studioT('Available models')}
      description={
        model ? (
          <div className="flex items-center gap-2">
            {studioT('Selected model:') + ' '}
            <ActiveModelBadge provider={model.provider} name={model.name} />
          </div>
        ) : undefined
      }
      contentClassName="overflow-hidden"
      cta={
        <Button iconEnd={<IconArrowRight />} onClick={handleContinue} disabled={isStreaming}>
          {studioT('Continue')}
        </Button>
      }
    >
      <Models editable={!isStreaming} />
    </AgentStepContainer>
  );
};
