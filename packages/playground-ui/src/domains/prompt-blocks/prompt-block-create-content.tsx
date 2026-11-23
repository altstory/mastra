import type { CreateStoredPromptBlockParams } from '@mastra/client-js';
import { useStoredPromptBlockMutations } from '@mastra/react/hooks/prompt-blocks';
import { AgentEditLayout } from './edit-layout';
import { PromptBlockEditMain } from './prompt-block-edit-page/prompt-block-edit-main';

import { PromptBlockEditSidebar } from './prompt-block-edit-page/prompt-block-edit-sidebar';
import { usePromptBlockEditForm } from './prompt-block-edit-page/use-prompt-block-edit-form';
import { Form } from '@/ds/components/Form';
import { t as studioT, useLocale } from '@/lib/i18n';
import { toast } from '@/utils/toast';

interface PromptBlockCreateContentProps {
  onSuccess?: (block: { id: string }) => void;
}

export function PromptBlockCreateContent({ onSuccess }: PromptBlockCreateContentProps) {
  useLocale();
  const { createStoredPromptBlock } = useStoredPromptBlockMutations();
  const { form } = usePromptBlockEditForm();

  const handlePublish = async () => {
    const isValid = await form.trigger();
    if (!isValid) {
      toast.error(studioT('Please fill in all required fields'));
      return;
    }

    const values = form.getValues();

    try {
      const createParams: CreateStoredPromptBlockParams = {
        name: values.name,
        description: values.description || undefined,
        content: values.content,
        rules: values.rules || undefined,
        requestContextSchema: (values.variables as Record<string, unknown>) || undefined,
      };

      const created = await createStoredPromptBlock.mutateAsync(createParams);
      toast.success(studioT('Prompt block created successfully'));
      onSuccess?.(created);
    } catch (error) {
      toast.error(
        studioT('Failed to create prompt block: {value0}', {
          value0: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  };

  return (
    <AgentEditLayout
      leftSlot={
        <PromptBlockEditSidebar
          form={form}
          onPublish={handlePublish}
          isSubmitting={createStoredPromptBlock.isPending}
        />
      }
    >
      <Form className="h-full">
        <PromptBlockEditMain form={form} />
      </Form>
    </AgentEditLayout>
  );
}
