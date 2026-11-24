import type { Agent } from '@mastra/core/agent';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import type { SubagentRuntime } from './runtime';

const teamTool = (name: string) => name.startsWith('team_task_');

/** Like DSH, the root setting gates shared tasks and team policy, not ordinary subagents. */
export function subagentProcessor(runtime: SubagentRuntime, getAgent?: () => Agent) {
  return {
    id: 'altflow-subagents',
    async processInputStep(args: ProcessInputStepArgs) {
      const info = args.messageList.serialize().memoryInfo;
      const actor = await runtime.actor(args.requestContext, info?.threadId);
      const model =
        typeof args.model === 'string'
          ? args.model
          : args.model &&
              typeof args.model === 'object' &&
              'provider' in args.model &&
              'modelId' in args.model &&
              String(args.model.provider).startsWith('altflow')
            ? `altflow/${args.model.modelId}`
            : undefined;
      const reasoning = args.providerOptions?.altflow?.reasoningLevel;
      const agent = args.agent ?? getAgent?.();
      if (agent)
        await runtime.attach(actor, agent, model, typeof reasoning === 'string' ? reasoning : undefined, args.runId);
      const enabled = await runtime.teamEnabled(actor);
      const tools = Object.fromEntries(Object.entries(args.tools ?? {}).filter(([name]) => enabled || !teamTool(name)));
      const inbox = await runtime.inbox(actor);
      const existing = new Set(args.messages.map(message => message.id));
      for (const mail of inbox)
        if (!existing.has(mail.id) && args.sendSignal)
          await args.sendSignal({
            id: mail.id,
            type: 'notification',
            tagName: 'subagent',
            contents: `${mail.sender}: ${mail.contents}`,
          });
      if (args.sendSignal)
        await runtime.acknowledge(
          actor,
          inbox.map(mail => mail.id),
        );
      args.messageList.clearSystemMessages('altflow-subagents');
      args.messageList.addSystem(
        `Your name is ${await runtime.selfName(actor)}. You share only this conversation's workspace with its collaborators, never files from other conversations. Use subagent or subagent_fork for independent work and send_message to continue collaborators. Wait for required child results before answering. Do not claim a child result before it arrives.${enabled ? '\nAgent teamwork is enabled. Use team_task_list/get, claim with the latest revision, perform work, then complete. Dependencies order work. Write scopes are advisory; split file edits to avoid overlaps. Task changes do not start agents or send messages. Use send_message when another agent must act.' : ''}`,
        'altflow-subagents',
      );
      return {
        tools,
        ...(args.activeTools
          ? {
              activeTools: args.activeTools.filter(name => enabled || !teamTool(name)),
            }
          : {}),
      };
    },
  };
}
