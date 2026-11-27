import type { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { internalReferencePolicy, referenceRedirect } from './internal-reference-policy';
import { isInternalTool, isPrivateReferenceTool } from './reference-visibility';

type ChatModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>;
type ChatPrompt = Parameters<ChatModel['doGenerate']>[0]['prompt'];
type Generated = Awaited<ReturnType<ChatModel['doGenerate']>>;
type Streamed = Awaited<ReturnType<ChatModel['doStream']>>;
type StreamPart = Streamed['stream'] extends ReadableStream<infer Part> ? Part : never;

const referenceDescription =
  /(?:内部\s*(?:参考|资料|规则|知识库|技能|提示词|指令|文档)|(?:系统|隐藏)\s*(?:提示词|指令)|\b(?:internal|private|hidden)\s+(?:reference|knowledge\s+base|skill|instruction|prompt|materials?)|\b(?:system\s+prompt|skill\.md|knowledge_(?:read|search|list))\b)/iu;
const referenceRequest =
  /(?:查看|看看|列[出举]|提供|展示|公开|透露|告诉|读出|导出|发送|原文|目录|清单|标题|路径|逐字|全文|复述|叫什么|有哪些|是什么|都有什么|\b(?:show|list|reveal|share|print|provide|display|read|repeat|what)\b)/iu;
const selfReference =
  /(?:你(?:们)?(?:的|有|用的|加载的)\s*(?:资料|参考|知识库|技能|提示词|指令|底稿)|\b(?:your|platform)\s+(?:reference|knowledge\s+base|skill|instruction|prompt|materials?))/iu;
const disclosureContext =
  /(?:我的|我们的|我(?:所)?(?:用来|用的|调用|加载|查到|参考|使用)|(?:来自|基于|根据)(?:我的|我们的)?|(?:以下|下面)(?:是|为)|给你看|供(?:我|内部)使用|\b(?:my|our|according to|based on|here (?:is|are)|comes? from)\b)/iu;
const sourceIdentifier = /\b(?:skill\.md|knowledge_(?:read|search|list))\b/iu;
const sourceField =
  /^(?:name|title|slug|path|ref|address|description|body|content|text|instructions|excerpt|snippet|lines?|headings?|matches|summary|value)$/i;
const metadataField = /^(?:name|title|slug|path|ref|address)$/i;
const excerptSize = 24;
const excerptStride = 12;
const sentenceBoundary = /[\n。！？!?]/u;
const fragmentBoundary = /[\s。！？!?，、；：,;]/u;
const afterLastSentence = /[^\n。！？!?]*$/u;
const afterLastFragment = /[^\s。！？!?，、；：,;]*$/u;
const han = /^\p{Script=Han}$/u;
const pinnedKnowledge = /^\s*<pinned-knowledge(?:[\s>-])/u;
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

function textValues(value: unknown, includeAll = false, key = ''): string[] {
  if (typeof value === 'string') {
    if (!includeAll && key && !sourceField.test(key)) return [];
    const normalized = normalize(value);
    const minimum = metadataField.test(key) ? 8 : excerptSize;
    if (normalized.length < minimum) return [];
    if (metadataField.test(key)) return [normalized];
    const excerpts = [];
    for (let i = 0; i + excerptSize <= normalized.length; i += excerptStride) {
      excerpts.push(normalized.slice(i, i + excerptSize));
    }
    excerpts.push(normalized.slice(-excerptSize));
    return excerpts;
  }
  if (Array.isArray(value)) return value.flatMap(item => textValues(item, includeAll, key));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([field, item]) => textValues(item, includeAll, field));
}

function decoded(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function valuesForTool(output: unknown): string[] {
  if (!output || typeof output !== 'object' || !('value' in output)) return [];
  const value = output.value;
  if (typeof value === 'string') return textValues(decoded(value));
  return textValues(value);
}

function outputStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(outputStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(outputStrings);
  return [];
}

export function referenceOutputGuard(prompt: ChatPrompt) {
  const system = prompt.find(message => message.role === 'system' && message.content.includes(internalReferencePolicy));
  if (!system) return;
  let question = '';
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== 'user') continue;
    question = message.content
      .flatMap(part => (part.type === 'text' && !pinnedKnowledge.test(part.text) ? [part.text] : []))
      .join('\n');
    if (question.trim()) break;
  }
  const asksForReferences =
    (referenceDescription.test(question) || selfReference.test(question)) && referenceRequest.test(question);
  const protectedText = prompt.flatMap(message => {
    if (message.role === 'system') return textValues(message.content, true);
    if (message.role === 'tool')
      return message.content.flatMap(part =>
        part.type === 'tool-result' && isPrivateReferenceTool(part.toolName) ? valuesForTool(part.output) : [],
      );
    if (message.role === 'user')
      return message.content.flatMap(part =>
        part.type === 'text' && pinnedKnowledge.test(part.text) ? textValues(part.text, true) : [],
      );
    return [];
  });
  const excerpts = new Set(protectedText.filter(phrase => phrase.length === excerptSize));
  const metadata = new Set(protectedText.filter(phrase => phrase.length !== excerptSize));
  const protectedPhrases = [...new Set(protectedText)].sort();
  const maxPhraseLength = protectedPhrases.reduce((max, phrase) => Math.max(max, phrase.length), 0);

  const mayCompleteProtectedPhrase = (text: string, cut: number) => {
    const prefixLength = normalize(text.slice(0, cut)).length;
    const normalized = normalize(text);
    for (let i = Math.max(0, normalized.length - maxPhraseLength + 1); i < prefixLength; i++) {
      const suffix = normalized.slice(i);
      let low = 0;
      let high = protectedPhrases.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (protectedPhrases[mid]! < suffix) low = mid + 1;
        else high = mid;
      }
      if (protectedPhrases[low]?.startsWith(suffix)) return true;
    }
    return false;
  };

  const blocked = (text: string, inputs: string[]) => {
    if (asksForReferences) return true;
    for (const candidate of [text, ...inputs]) {
      if (sourceIdentifier.test(candidate)) return true;
      if (
        candidate.split(sentenceBoundary).some(line => referenceDescription.test(line) && disclosureContext.test(line))
      )
        return true;
      const normalized = normalize(candidate);
      for (const phrase of metadata) if (normalized.includes(phrase)) return true;
      for (let i = 0; i + excerptSize <= normalized.length; i++) {
        if (excerpts.has(normalized.slice(i, i + excerptSize))) return true;
      }
    }
    return false;
  };
  const publicInput = (name: string, input: string) => (isInternalTool(name) ? [] : outputStrings(decoded(input)));

  return {
    generate(result: Generated): Generated {
      const text = result.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
      const inputs = result.content.flatMap(part =>
        part.type === 'tool-call' ? publicInput(part.toolName, part.input) : [],
      );
      if (!blocked(text, inputs)) return result;
      const { response, providerMetadata: _metadata, ...rest } = result;
      return {
        ...rest,
        response: response && { id: response.id, modelId: response.modelId, timestamp: response.timestamp },
        content: [{ type: 'text', text: referenceRedirect }],
        finishReason: { unified: 'stop', raw: 'stop' },
      };
    },
    stream(result: Streamed): Streamed {
      let pending: StreamPart[] = [];
      let text = '';
      let sentSentence = '';
      let sawTool = false;
      let rejected = asksForReferences;
      let finished = false;
      const openText = new Set<string>();
      const emit = (part: StreamPart, controller: TransformStreamDefaultController<StreamPart>) => {
        if (part.type === 'text-start') openText.add(part.id);
        if (part.type === 'text-end') openText.delete(part.id);
        controller.enqueue(part);
      };
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(part, controller) {
              if (finished || part.type === 'raw') return;
              if (part.type === 'stream-start' || part.type === 'response-metadata' || part.type === 'error') {
                controller.enqueue(part);
                return;
              }
              if (part.type !== 'finish') {
                if (rejected) return;
                pending.push(part);
                if (part.type.startsWith('tool-')) sawTool = true;
                if (part.type !== 'text-delta') return;
                text += part.delta;
                if (sawTool || (text.length < excerptSize * 2 && !fragmentBoundary.test(text))) return;
                if (blocked(sentSentence + text, [])) {
                  rejected = true;
                  return;
                }
                const lastSentence = text.search(afterLastSentence);
                const sentenceTail = (lastSentence ? '' : sentSentence) + text.slice(lastSentence);
                let cut = lastSentence;
                if (!referenceDescription.test(sentenceTail)) {
                  cut = text.search(afterLastFragment);
                  const incrementalCut = text.length - excerptSize;
                  if (
                    incrementalCut - cut >= excerptSize &&
                    han.test(text[incrementalCut - 1]!) &&
                    han.test(text[incrementalCut]!)
                  ) {
                    cut = incrementalCut;
                  }
                }
                if (cut === 0 || mayCompleteProtectedPhrase(text, cut)) return;
                const remaining: StreamPart[] = [];
                let sent = 0;
                for (const chunk of pending) {
                  if (chunk.type === 'text-delta' && sent < cut) {
                    const size = Math.min(chunk.delta.length, cut - sent);
                    emit({ ...chunk, delta: chunk.delta.slice(0, size) }, controller);
                    sent += size;
                    if (size < chunk.delta.length) remaining.push({ ...chunk, delta: chunk.delta.slice(size) });
                  } else if (chunk.type === 'text-start' && sent < cut) {
                    emit(chunk, controller);
                  } else if (
                    chunk.type === 'text-end' &&
                    openText.has(chunk.id) &&
                    !remaining.some(item => item.type === 'text-delta' && item.id === chunk.id)
                  ) {
                    emit(chunk, controller);
                  } else {
                    remaining.push(chunk);
                  }
                }
                pending = remaining;
                const sentText = sentSentence + text.slice(0, cut);
                sentSentence = sentText.slice(sentText.search(afterLastSentence));
                text = text.slice(cut);
                return;
              }
              finished = true;
              const inputs = pending.flatMap(chunk =>
                chunk.type === 'tool-call' ? publicInput(chunk.toolName, chunk.input) : [],
              );
              if (rejected || blocked(sentSentence + text, inputs)) {
                for (const id of openText) controller.enqueue({ type: 'text-end', id });
                const id = 'reference-redirect';
                controller.enqueue({ type: 'text-start', id });
                controller.enqueue({ type: 'text-delta', id, delta: referenceRedirect });
                controller.enqueue({ type: 'text-end', id });
                controller.enqueue({
                  type: 'finish',
                  usage: part.usage,
                  finishReason: { unified: 'stop', raw: 'stop' },
                });
              } else {
                for (const chunk of pending) controller.enqueue(chunk);
                controller.enqueue(part);
              }
              pending.length = 0;
            },
          }),
        ),
      };
    },
  };
}
