import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ALTFLOW_ACCOUNT_RESOURCE_KEY } from '@mastra/altflow-tools';
import type { Agent } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import {
  RequestContext,
  MASTRA_NORMALIZED_USER_KEY,
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_SCOPES_KEY,
} from '@mastra/core/request-context';
import type { MemoryStorage } from '@mastra/core/storage';
import { z } from 'zod';
import type { SubagentStore, Child, Mail, Tree } from './store';
import { creatorMeterContext, trackCreatorBackground } from '../creator-meter';

export const CHILD_ROOT = 'mastra__altflowSubagentRoot';
const userSchema = z.object({
  id: z.string().min(1),
  username: z.string().optional(),
  role: z.enum(['admin', 'creator', 'user']).optional(),
});
export interface Actor {
  owner: string;
  resourceId: string;
  root: string;
  self: string;
  context: RequestContext;
}
export class SubagentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
export function childResource(actor: Actor) {
  return `altflow-subagent:${JSON.stringify([actor.owner, actor.root])}`;
}
export function childContext(actor: Actor) {
  const context = new RequestContext();
  const user = userSchema.parse(actor.context.getRaw(MASTRA_NORMALIZED_USER_KEY));
  context.setRaw(MASTRA_NORMALIZED_USER_KEY, user);
  context.setRaw(ALTFLOW_ACCOUNT_RESOURCE_KEY, actor.resourceId);
  context.setRaw(CHILD_ROOT, actor.root);
  context.set(MASTRA_RESOURCE_ID_KEY, childResource(actor));
  context.set(MASTRA_SCOPES_KEY, [
    `resource:${childResource(actor)}`,
    ...(user.role === 'admin' ? ['library:creator'] : []),
  ]);
  return context;
}
export class SubagentRuntime {
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private roots = new Map<string, { actor: Actor; agent: Agent; model?: string; reasoningLevel?: string }>();
  private activeRuns = new Map<string, { agent: Agent; runId: string }>();
  private closed = false;
  private wakes = new Set<Promise<void>>();
  private wakeControllers = new Set<AbortController>();
  constructor(
    readonly store: SubagentStore,
    private options: {
      memory: MemoryStorage;
      createChild: (child: Child, actor: Actor) => Agent;
      teamEnabled: (actor: Actor) => Promise<boolean>;
      maxActive?: number;
    },
  ) {}
  private key(actor: Actor, id = '') {
    return JSON.stringify([actor.owner, actor.root, id]);
  }
  async actor(context: RequestContext | undefined, threadId: string | undefined): Promise<Actor> {
    const user = userSchema.parse(context?.getRaw(MASTRA_NORMALIZED_USER_KEY));
    const resourceId = context?.getRaw(ALTFLOW_ACCOUNT_RESOURCE_KEY) ?? context?.get(MASTRA_RESOURCE_ID_KEY);
    if (!context || !threadId || typeof resourceId !== 'string')
      throw new SubagentError('UNAUTHORIZED', 'Authenticated memory thread required.');
    const root = context.getRaw(CHILD_ROOT);
    if (typeof root === 'string') {
      const parent = await this.options.memory.getThreadById({
        threadId: root,
      });
      if (!parent || parent.resourceId !== resourceId)
        throw new SubagentError('UNAUTHORIZED', 'Parent thread is outside this account.');
      const tree = await this.store.read(user.id, root);
      if (!tree.children.some(child => child.id === threadId))
        throw new SubagentError('UNAUTHORIZED', 'Child is outside this tree.');
      return { owner: user.id, resourceId, root, self: threadId, context };
    }
    const thread = await this.options.memory.getThreadById({ threadId });
    if (!thread || thread.resourceId !== resourceId)
      throw new SubagentError('UNAUTHORIZED', 'Thread is outside this account.');
    return {
      owner: user.id,
      resourceId,
      root: threadId,
      self: threadId,
      context,
    };
  }
  async teamEnabled(actor: Actor) {
    return this.options.teamEnabled(actor);
  }
  async attach(actor: Actor, agent: Agent, model?: string, reasoningLevel?: string, runId?: string) {
    runId ??= agent.getActiveThreadRunId({
      threadId: actor.self,
      resourceId: actor.self === actor.root ? actor.resourceId : childResource(actor),
    });
    if (runId) this.activeRuns.set(this.key(actor, actor.self), { agent, runId });
    if (actor.self !== actor.root) return;
    this.roots.set(this.key(actor), {
      actor,
      agent,
      model,
      reasoningLevel,
    });
    const saved = await this.store.read(actor.owner, actor.root);
    if (saved.children.some(child => child.state === 'preparing' && child.lease < Date.now()))
      await this.store.edit(actor.owner, actor.root, tree => {
        for (const child of tree.children)
          if (child.state === 'preparing' && child.lease < Date.now()) {
            child.state = 'failed';
            child.error = 'Initialization was interrupted. Create a new child to retry.';
          }
      });
    const tree = await this.store.read(actor.owner, actor.root);
    // Cold restore only after a freshly authenticated owner visits this root.
    for (const child of tree.children)
      if (child.state === 'queued' || (child.state === 'running' && child.lease < Date.now()))
        void this.launch(actor, child.id);
  }
  private resolve(tree: Tree, actor: Actor, name: string) {
    if (name === 'lead' || name === actor.root) return actor.root;
    const child = tree.children.find(child => child.id === name || child.name === name);
    if (!child) throw new SubagentError('UNAUTHORIZED', 'Agent is outside this conversation tree.');
    return child.id;
  }
  private checkCapacity(tree: Tree, excluding?: string) {
    const active = tree.children.filter(
      child => child.id !== excluding && ['preparing', 'running', 'queued'].includes(child.state),
    ).length;
    if (active >= (this.options.maxActive ?? 8))
      throw new SubagentError('ACTIVATION_LIMIT_REACHED', 'Wait for an active child to finish.');
  }
  async spawn(
    actor: Actor,
    input: { name?: string; description: string; prompt: string },
    fork: readonly MastraDBMessage[] = [],
    model?: string,
  ) {
    if (actor.self !== actor.root) throw new SubagentError('MAX_DEPTH_REACHED', 'Maximum subagent depth is 1.');
    const child = await this.store.edit(actor.owner, actor.root, tree => {
      this.checkCapacity(tree);
      const name = input.name ?? `agent-${tree.children.length + 1}`;
      if (name === 'lead' || tree.children.some(child => child.name === name))
        throw new SubagentError('NAME_CONFLICT', 'Choose a unique agent name.');
      const child: Child = {
        id: randomUUID(),
        parent: actor.self,
        name,
        description: input.description,
        prompt: input.prompt,
        state: 'preparing',
        generation: 0,
        lease: Date.now() + 30000,
        forked: fork.length > 0,
        model: model ?? this.roots.get(this.key(actor))?.model,
        reasoningLevel: this.roots.get(this.key(actor))?.reasoningLevel,
      };
      tree.children.push(child);
      return child;
    });
    try {
      await this.options.memory.saveThread({
        thread: {
          id: child.id,
          resourceId: childResource(actor),
          title: child.description,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: { subagentRoot: actor.root, subagentName: child.name },
        },
      });
      if (fork.length)
        await this.options.memory.saveMessages({
          messages: fork.map(message => ({
            ...message,
            id: randomUUID(),
            threadId: child.id,
            resourceId: childResource(actor),
          })),
        });
    } catch (error) {
      await this.store.edit(actor.owner, actor.root, tree => {
        const row = tree.children.find(row => row.id === child.id)!;
        row.state = 'failed';
        row.error = 'Child history could not be saved.';
      });
      throw error;
    }
    await this.store.edit(actor.owner, actor.root, tree => {
      tree.children.find(row => row.id === child.id)!.state = 'queued';
    });
    void this.launch(actor, child.id);
    return { kind: 'activation' as const, name: child.name };
  }
  async selfName(actor: Actor) {
    if (actor.self === actor.root) return 'lead';
    const tree = await this.store.read(actor.owner, actor.root);
    return tree.children.find(child => child.id === actor.self)!.name;
  }
  async list(actor: Actor) {
    const tree = await this.store.read(actor.owner, actor.root);
    return {
      agents: [
        { name: 'lead', state: 'available', parent: undefined },
        ...tree.children.map(child => ({
          name: child.name,
          parent: 'lead',
          description: child.description,
          state: child.state,
          result: child.result,
          error: child.error,
        })),
      ],
    };
  }
  async message(actor: Actor, name: string, contents: string) {
    return this.enqueue(actor, name, contents);
  }
  private async enqueue(actor: Actor, name: string, contents: string, persistInput?: () => Promise<unknown>) {
    const mail = await this.store.edit(actor.owner, actor.root, async tree => {
      const target = this.resolve(tree, actor, name);
      if (target === actor.self) throw new SubagentError('INVALID_TARGET', 'Send to another agent.');
      const sender = actor.self === actor.root ? 'lead' : tree.children.find(child => child.id === actor.self)!.name;
      const mail: Mail = {
        id: randomUUID(),
        sender,
        target,
        contents,
        type: 'message',
        delivered: false,
        createdAt: new Date().toISOString(),
      };
      if (target !== actor.root) {
        const child = tree.children.find(child => child.id === target)!;
        if (!['preparing', 'running', 'queued'].includes(child.state)) {
          this.checkCapacity(tree, target);
          child.state = 'queued';
        }
      }
      // Reserve capacity before accepting direct user input. A failed history write
      // rolls back admission, and no runner can consume the message before it is saved.
      await persistInput?.();
      tree.mail.push(mail);
      return mail;
    });
    if (mail.target === actor.root) this.notifyRoot(actor, mail);
    else void this.launch(actor, mail.target);
    return { messageId: mail.id };
  }
  async interrupt(actor: Actor, name: string) {
    const id = await this.store.edit(actor.owner, actor.root, tree => {
      const id = this.resolve(tree, actor, name);
      if (actor.self !== actor.root || id === actor.root)
        throw new SubagentError('UNAUTHORIZED', 'Only an ancestor can interrupt its child.');
      const child = tree.children.find(child => child.id === id)!;
      child.finishedAt = Date.now();
      if (child.state === 'running')
        child.elapsedMs =
          (child.elapsedMs ?? 0) + Math.max(0, child.finishedAt - (child.startedAt ?? child.finishedAt));
      child.state = 'interrupted';
      child.generation++;
      child.lease = 0;
      return id;
    });
    this.running.get(this.key(actor, id))?.controller.abort();
    const mail = await this.store.edit(actor.owner, actor.root, tree => {
      const child = tree.children.find(child => child.id === id)!;
      const mail: Mail = {
        id: randomUUID(),
        sender: child.name,
        target: actor.root,
        contents: 'Interrupted. Send a message to resume.',
        type: 'completion',
        delivered: false,
        createdAt: new Date().toISOString(),
      };
      tree.mail.push(mail);
      return mail;
    });
    this.notifyRoot(actor, mail);
    return { accepted: true };
  }
  async inbox(actor: Actor) {
    return (await this.store.read(actor.owner, actor.root)).mail.filter(
      mail => mail.target === actor.self && !mail.delivered,
    );
  }
  async acknowledge(actor: Actor, ids: string[]) {
    if (!ids.length) return;
    await this.store.edit(actor.owner, actor.root, tree => {
      for (const mail of tree.mail) if (mail.target === actor.self && ids.includes(mail.id)) mail.delivered = true;
    });
  }
  async wait(actor: Actor, timeout: number, signal?: AbortSignal) {
    const until = Date.now() + timeout;
    let notified = false;
    const run = this.activeRuns.get(this.key(actor, actor.self));
    // Subscribe without draining: Mastra admits these signals at the next model step.
    const unsubscribe = run?.agent.__getSubscribePendingSignals()(run.runId, signals => {
      if (signals?.length) notified = true;
    });
    try {
      while (true) {
        signal?.throwIfAborted();
        if (notified || (await this.inbox(actor)).length) return { timedOut: false };
        if (Date.now() >= until) return { timedOut: true };
        await delay(Math.min(100, until - Date.now()), undefined, { signal });
      }
    } finally {
      unsubscribe?.();
    }
  }
  private notifyRoot(actor: Actor, mail: Mail) {
    const promise = this.wakeRoot(actor, mail);
    this.wakes.add(promise);
    trackCreatorBackground(promise);
    void promise.finally(() => this.wakes.delete(promise));
  }
  private async wakeRoot(actor: Actor, mail: Mail) {
    const root = this.roots.get(this.key(actor));
    const meter = creatorMeterContext.getStore();
    if (!root || this.closed || meter?.controller?.signal.aborted) return; // Persisted inbox is delivered on the next authenticated root turn.
    const controller = new AbortController();
    this.wakeControllers.add(controller);
    try {
      // Completion can arrive after the user deletes the conversation. Mastra's
      // idle wake creates missing threads, so recheck the durable owner first.
      const thread = await this.options.memory.getThreadById({ threadId: actor.root });
      if (!thread || thread.resourceId !== actor.resourceId || this.closed) return;
      const delivery = await root.agent.sendSignal(
        {
          id: mail.id,
          type: 'notification',
          tagName: 'subagent',
          contents: `${mail.sender}: ${mail.contents}`,
        },
        {
          threadId: actor.root,
          resourceId: actor.resourceId,
          ifIdle: {
            streamOptions: {
              abortSignal: controller.signal,
              requestContext: root.actor.context,
              ...(root.model ? { model: root.model } : {}),
              ...(root.reasoningLevel
                ? {
                    providerOptions: {
                      altflow: { reasoningLevel: root.reasoningLevel },
                    },
                  }
                : {}),
              memory: { thread: actor.root, resource: actor.resourceId },
            },
          },
        },
      );
      const accepted = await delivery.accepted;
      if (accepted.action === 'wake') {
        await meter?.onRootWake?.(accepted.runId);
        await accepted.output.consumeStream();
        if (meter) meter.rootFinishReason = await accepted.output.finishReason;
      }
      // The step processor acknowledges the outbox after admitting its signal, not before.
    } catch {
      /* Keep the durable inbox for the next authenticated turn. */
    } finally {
      this.wakeControllers.delete(controller);
    }
  }
  private async launch(actor: Actor, id: string) {
    const key = this.key(actor, id);
    if (this.closed || this.running.has(key)) return;
    const controller = new AbortController();
    const done = this.run(actor, id, controller)
      .catch(() => {})
      .finally(async () => {
        this.running.delete(key);
        if (
          !this.closed &&
          (await this.store.read(actor.owner, actor.root)).children.some(
            child => child.id === id && child.state === 'queued',
          )
        )
          void this.launch(actor, id);
      });
    this.running.set(key, { controller, done });
    trackCreatorBackground(done, controller);
  }
  private async run(actor: Actor, id: string, controller: AbortController) {
    const child = await this.store.edit(actor.owner, actor.root, tree => {
      const child = tree.children.find(child => child.id === id)!;
      if (child.state !== 'queued' && !(child.state === 'running' && child.lease < Date.now())) return undefined;
      child.state = 'running';
      child.startedAt = Date.now();
      child.finishedAt = undefined;
      child.generation++;
      child.lease = Date.now() + 30000;
      return { ...child };
    });
    if (!child) return;
    const heartbeat = setInterval(
      () =>
        void this.store
          .edit(actor.owner, actor.root, tree => {
            const row = tree.children.find(row => row.id === id);
            if (row?.generation === child.generation && row.state === 'running') row.lease = Date.now() + 30000;
          })
          .catch(() => {}),
      10000,
    );
    heartbeat.unref();
    let result = '',
      error: string | undefined,
      tokens: number | undefined;
    const baseTokens = child.totalTokens ?? 0;
    const recordUsage = async (
      usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
      cumulative: boolean,
    ) => {
      const reported =
        usage.totalTokens ??
        (usage.inputTokens !== undefined && usage.outputTokens !== undefined
          ? usage.inputTokens + usage.outputTokens
          : undefined);
      if (reported === undefined || !Number.isFinite(reported) || reported < 0) return;
      tokens = cumulative ? Math.max(tokens ?? 0, reported) : (tokens ?? 0) + reported;
      const total = baseTokens + tokens;
      await this.store.edit(actor.owner, actor.root, tree => {
        const row = tree.children.find(row => row.id === id);
        if (row?.generation === child.generation) row.totalTokens = total;
      });
    };
    try {
      const agent = this.options.createChild(child, actor);
      const prompt =
        child.generation === 1
          ? child.prompt
          : `Original task: ${child.prompt}\nContinue from the saved conversation. Check completed work before repeating actions. Read new messages from your collaborators.`;
      const stream = await agent.stream(prompt, {
        requestContext: childContext(actor),
        // The child view reads stored messages while the agent is still running.
        savePerStep: true,
        memory: { thread: id, resource: childResource(actor) },
        abortSignal: controller.signal,
        onStepFinish: async step => {
          await recordUsage(step.usage, false);
        },
        ...(child.reasoningLevel
          ? {
              providerOptions: {
                altflow: { reasoningLevel: child.reasoningLevel },
              },
            }
          : {}),
      });
      await stream.consumeStream();
      if (stream.status === 'suspended')
        throw new SubagentError('CHILD_SUSPENDED', 'Ask the lead to handle user approval before continuing.');
      result = await stream.text;
      const usage = await stream.totalUsage;
      await recordUsage(usage, true);
      if (stream.status === 'failed' || stream.status === 'tripwire' || stream.status === 'canceled')
        throw new Error('Child model run failed.');
    } catch (caught) {
      error =
        caught instanceof SubagentError
          ? caught.message
          : controller.signal.aborted
            ? 'Interrupted.'
            : 'Subagent execution failed. Retry by sending a message.';
    } finally {
      clearInterval(heartbeat);
    }
    const mail = await this.store.edit(actor.owner, actor.root, tree => {
      const row = tree.children.find(row => row.id === id)!;
      if (row.generation !== child.generation) return undefined; // Fence interrupted/older activations.
      const pending = tree.mail.some(mail => mail.target === id && !mail.delivered);
      row.state = controller.signal.aborted ? 'interrupted' : error ? 'failed' : pending ? 'queued' : 'completed';
      row.lease = 0;
      row.result = result;
      row.error = error;
      row.finishedAt = Date.now();
      row.elapsedMs = (row.elapsedMs ?? 0) + Math.max(0, row.finishedAt - (child.startedAt ?? row.finishedAt));
      if (tokens !== undefined) row.totalTokens = baseTokens + tokens;
      const mail: Mail = {
        id: randomUUID(),
        sender: row.name,
        target: row.parent,
        type: 'completion',
        contents: error ?? result,
        delivered: false,
        createdAt: new Date().toISOString(),
      };
      tree.mail.push(mail);
      return mail;
    });
    if (mail) this.notifyRoot(actor, mail);
  }
  /** UI projections never accept a caller-supplied child resource or account. */
  async snapshot(actor: Actor, childId?: string, page = 0) {
    const tree = await this.store.read(actor.owner, actor.root);
    const root = await this.options.memory.getThreadById({
      threadId: actor.root,
    });
    const children = tree.children.map(
      ({ id, name, description, state, startedAt, finishedAt, elapsedMs, totalTokens, error }) => ({
        id,
        name,
        description,
        state,
        startedAt,
        finishedAt,
        elapsedMs: (elapsedMs ?? 0) + (state === 'running' && startedAt ? Date.now() - startedAt : 0),
        totalTokens,
        error,
      }),
    );
    if (!childId)
      return {
        title: root?.title ?? '',
        children,
        messages: [],
        hasMore: false,
        page,
        teamEnabled: await this.teamEnabled(actor),
        tasks: tree.tasks,
      };
    const child = tree.children.find(child => child.id === childId);
    if (!child) throw new SubagentError('UNAUTHORIZED', 'Child is outside this conversation tree.');
    const history = await this.options.memory.listMessages({
      threadId: child.id,
      resourceId: childResource(actor),
      perPage: 50,
      page,
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });
    const messages = history.messages
      .map(message => {
        const parts = message.content.parts ?? [];
        const text = parts
          .filter(part => part.type === 'text')
          .map(part => (part.type === 'text' ? part.text : ''))
          .join('\n');
        const tools = parts.flatMap(part =>
          part.type === 'tool-invocation'
            ? [
                {
                  name: part.toolInvocation.toolName,
                  state: part.toolInvocation.state,
                },
              ]
            : [],
        );
        return {
          id: message.id,
          role: message.role,
          text,
          tools,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
        };
      })
      .filter(message => ['user', 'assistant', 'system', 'signal'].includes(message.role));
    return {
      title: root?.title ?? '',
      children,
      messages: messages.reverse(),
      hasMore: history.hasMore,
      page,
      teamEnabled: await this.teamEnabled(actor),
      tasks: tree.tasks,
    };
  }
  async promptChild(actor: Actor, id: string, prompt: string) {
    const tree = await this.store.read(actor.owner, actor.root);
    const child = tree.children.find(child => child.id === id);
    if (!child) throw new SubagentError('UNAUTHORIZED', 'Child is outside this conversation tree.');
    return this.enqueue(actor, child.name, `The user has sent this instruction directly: ${prompt}`, () =>
      this.options.memory.saveMessages({
        messages: [
          {
            id: randomUUID(),
            threadId: id,
            resourceId: childResource(actor),
            role: 'user',
            createdAt: new Date(),
            content: { format: 2, parts: [{ type: 'text', text: prompt }] },
          },
        ],
      }),
    );
  }
  async close() {
    this.closed = true;
    for (const value of this.running.values()) value.controller.abort();
    for (const controller of this.wakeControllers) controller.abort();
    await Promise.allSettled([...this.running.values()].map(value => value.done));
    await Promise.allSettled([...this.wakes]);
    this.roots.clear();
    this.activeRuns.clear();
  }
}
