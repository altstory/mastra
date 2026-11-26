import { Button } from '@mastra/playground-ui/components/Button';
import { IconArrowRight } from '@mastra/playground-ui/icons/central/IconArrowRight';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { AgentStepContainer } from './agent-step-container';
import { Instructions } from './instructions';
import { useStreamRunning } from '@/domains/agent-builder/contexts/stream-chat-context';
import { useWizard } from '@/domains/agent-builder/contexts/wizard-context';
import { startViewTransition } from '@/lib/routing';

export const AgentProfileInstructionsStep = () => {
  useLocale();
  const { next } = useWizard();
  const isStreaming = useStreamRunning();

  const handleContinue = () => {
    startViewTransition(() => {
      next();
    });
  };

  return (
    <AgentStepContainer
      title={studioT('Instructions')}
      cta={
        <Button iconEnd={<IconArrowRight />} onClick={handleContinue} disabled={isStreaming}>
          {studioT('Continue')}
        </Button>
      }
    >
      <Instructions editable={!isStreaming} />
    </AgentStepContainer>
  );
};
