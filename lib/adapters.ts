import { randomUUID } from 'node:crypto';
import type {
  CanonicalRequest,
  ChatMessage,
  ImagePart,
  IncomingFormat,
  Protocol,
  UpstreamResult,
  Usage,
} from './types';

type Json = Record<string, any>;

function shortId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseDataUrl(value: string): ImagePart | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) return null;
  if (!match[2]) return null;
  return { mime: match[1] || 'image/png', data: match[3] };
}

function imageFromOpenAi(value: any): ImagePart | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const data = parseDataUrl(value);
    return data ?? { url: value };
  }
  if (typeof value === 'object' && typeof value.url === 'string') {
    const data = parseDataUrl(value.url);
    return data ?? { url: value.url };
  }
  return null;
}

function imageFromAnthropic(block: any): ImagePart | null {
  if (block?.type !== 'image' || !block.source) return null;
  if (block.source.type === 'base64' && typeof block.source.data === 'string') {
    return { mime: stringOrEmpty(block.source.media_type) || 'image/png', data: block.source.data };
  }
  if (block.source.type === 'url' && typeof block.source.url === 'string') {
    return { url: block.source.url };
  }
  return null;
}

function extractContentParts(content: any): { text: string; images: ImagePart[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts: string[] = [];
  const images: ImagePart[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      if (typeof part.text === 'string') texts.push(part.text);
    } else if (part.type === 'image_url') {
      const image = imageFromOpenAi(part.image_url);
      if (image) images.push(image);
    } else if (part.type === 'input_image') {
      const image = imageFromOpenAi(part.image_url);
      if (image) images.push(image);
    } else if (part.type === 'image') {
      const image = imageFromAnthropic(part);
      if (image) images.push(image);
    }
  }
  return { text: texts.join('\n'), images };
}

function normalizeMessage(role: string, content: any): ChatMessage | null {
  if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
  const parts = extractContentParts(content);
  if (!parts.text && parts.images.length === 0) return null;
  return { role, content: parts.text, ...(parts.images.length ? { images: parts.images } : {}) };
}

export function parseOpenAIChat(body: Json): CanonicalRequest {
  if (!body || typeof body !== 'object') throw new Error('Request body must be a JSON object');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('model is required');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error('messages must be a non-empty array');
  const messages: ChatMessage[] = [];
  for (const item of body.messages) {
    if (!item || typeof item !== 'object') continue;
    const message = normalizeMessage(stringOrEmpty(item.role), item.content);
    if (message) messages.push(message);
  }
  if (messages.length === 0) throw new Error('messages does not contain any text or image content');
  return {
    model: body.model.trim(),
    messages,
    maxTokens: numberOrUndefined(body.max_tokens) ?? numberOrUndefined(body.max_completion_tokens),
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    stream: body.stream === true,
  };
}

export function parseOpenAIResponses(body: Json): CanonicalRequest {
  if (!body || typeof body !== 'object') throw new Error('Request body must be a JSON object');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('model is required');
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      if (item.type && item.type !== 'message') continue;
      const message = normalizeMessage(stringOrEmpty(item.role) || 'user', item.content);
      if (message) messages.push(message);
    }
  }
  if (messages.length === 0) throw new Error('input does not contain any text or image content');
  return {
    model: body.model.trim(),
    messages,
    maxTokens: numberOrUndefined(body.max_output_tokens),
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    stream: body.stream === true,
  };
}

export function parseAnthropic(body: Json): CanonicalRequest {
  if (!body || typeof body !== 'object') throw new Error('Request body must be a JSON object');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('model is required');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error('messages must be a non-empty array');
  const messages: ChatMessage[] = [];
  if (typeof body.system === 'string' && body.system.trim()) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const systemText = body.system
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n');
    if (systemText.trim()) messages.push({ role: 'system', content: systemText });
  }
  for (const item of body.messages) {
    if (!item || typeof item !== 'object') continue;
    const message = normalizeMessage(stringOrEmpty(item.role), item.content);
    if (message) messages.push(message);
  }
  if (messages.length === 0) throw new Error('messages does not contain any text or image content');
  return {
    model: body.model.trim(),
    messages,
    maxTokens: numberOrUndefined(body.max_tokens) ?? 1024,
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    stream: body.stream === true,
  };
}

function imageDataUrl(image: ImagePart): string | null {
  if (image.data) return `data:${image.mime || 'image/png'};base64,${image.data}`;
  if (image.url) return image.url;
  return null;
}

function toOpenAIChatMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (!message.images?.length || message.role !== 'user') {
      return { role: message.role, content: message.content };
    }
    const content: any[] = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    for (const image of message.images) {
      const url = imageDataUrl(image);
      if (url) content.push({ type: 'image_url', image_url: { url } });
    }
    return { role: message.role, content };
  });
}

function toResponsesInput(messages: ChatMessage[]) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean).join('\n\n');
  const input = messages
    .filter((m) => m.role !== 'system')
    .map((message) => {
      const content: any[] = [];
      if (message.content) {
        content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content });
      }
      if (message.role === 'user') {
        for (const image of message.images ?? []) {
          const url = imageDataUrl(image);
          if (url) content.push({ type: 'input_image', image_url: url });
        }
      }
      return { role: message.role, content };
    });
  return { system, input };
}

function mergeAnthropicMessages(messages: ChatMessage[]) {
  const output: { role: 'user' | 'assistant'; content: any[] }[] = [];
  for (const message of messages.filter((m) => m.role !== 'system')) {
    const content: any[] = [];
    if (message.role === 'user') {
      for (const image of message.images ?? []) {
        if (!image.data) continue;
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mime || 'image/png', data: image.data },
        });
      }
    }
    content.push({ type: 'text', text: message.content || '(attachment)' });
    if (output.length && output[output.length - 1].role === message.role) {
      output[output.length - 1].content.push(...content);
    } else {
      output.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
    }
  }
  return output;
}

export function buildUpstreamPayload(protocol: Protocol, request: CanonicalRequest, stream: boolean): Json {
  const base: Json = { model: request.model, stream };
  if (protocol === 'openai_chat') {
    const body: Json = { ...base, messages: toOpenAIChatMessages(request.messages) };
    if (request.maxTokens != null) body.max_tokens = request.maxTokens;
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }
  if (protocol === 'openai_responses') {
    const converted = toResponsesInput(request.messages);
    const body: Json = { ...base, input: converted.input };
    if (converted.system) body.instructions = converted.system;
    if (request.maxTokens != null) body.max_output_tokens = request.maxTokens;
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;
    return body;
  }
  const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean).join('\n\n');
  const body: Json = {
    ...base,
    max_tokens: request.maxTokens ?? 1024,
    messages: mergeAnthropicMessages(request.messages),
  };
  if (system) body.system = system;
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.topP != null) body.top_p = request.topP;
  return body;
}

function extractTextFromOpenAiContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('');
  }
  return '';
}

export function parseUpstreamJson(protocol: Protocol, payload: any): UpstreamResult {
  if (!payload || typeof payload !== 'object') throw new Error('Provider returned an empty response');
  if (protocol === 'openai_chat') {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const text = extractTextFromOpenAiContent(choice?.message?.content);
    return {
      text,
      usage: {
        inputTokens: numberOrUndefined(payload.usage?.prompt_tokens),
        outputTokens: numberOrUndefined(payload.usage?.completion_tokens),
      },
      raw: payload,
      finishReason: choice?.finish_reason,
    } as UpstreamResult;
  }
  if (protocol === 'openai_responses') {
    let text = typeof payload.output_text === 'string' ? payload.output_text : '';
    if (!text && Array.isArray(payload.output)) {
      const parts: string[] = [];
      for (const item of payload.output) {
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
        }
      }
      text = parts.join('');
    }
    return {
      text,
      usage: {
        inputTokens: numberOrUndefined(payload.usage?.input_tokens),
        outputTokens: numberOrUndefined(payload.usage?.output_tokens),
      },
      raw: payload,
      finishReason: payload.status,
    } as UpstreamResult;
  }
  const parts = Array.isArray(payload.content)
    ? payload.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text)
    : [];
  return {
    text: parts.join(''),
    usage: {
      inputTokens: numberOrUndefined(payload.usage?.input_tokens),
      outputTokens: numberOrUndefined(payload.usage?.output_tokens),
    },
    raw: payload,
    finishReason: payload.stop_reason,
  } as UpstreamResult;
}

export type ParsedUpstreamStream = {
  usage: Usage;
  text: string;
  finishReason?: string;
};

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: data.join('\n') };
      index = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    let event = 'message';
    const data: string[] = [];
    for (const line of buffer.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length) yield { event, data: data.join('\n') };
  }
}

export async function consumeUpstreamStream(
  protocol: Protocol,
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  onUsage: (usage: Usage) => void,
): Promise<ParsedUpstreamStream> {
  let text = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let finishReason: string | undefined;
  const emit = (delta: string) => {
    if (!delta) return;
    text += delta;
    onDelta(delta);
  };
  const updateUsage = () => {
    if (inputTokens != null || outputTokens != null) onUsage({ inputTokens, outputTokens });
  };

  for await (const { event, data } of sseEvents(body)) {
    if (data === '[DONE]') break;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (protocol === 'openai_chat') {
      const choice = Array.isArray(json.choices) ? json.choices[0] : null;
      emit(stringOrEmpty(choice?.delta?.content));
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) {
        inputTokens = numberOrUndefined(json.usage.prompt_tokens) ?? inputTokens;
        outputTokens = numberOrUndefined(json.usage.completion_tokens) ?? outputTokens;
        updateUsage();
      }
    } else if (protocol === 'openai_responses') {
      const type = event !== 'message' ? event : json.type;
      if (type === 'response.output_text.delta') emit(stringOrEmpty(json.delta));
      else if (type === 'response.completed') {
        inputTokens = numberOrUndefined(json.response?.usage?.input_tokens) ?? inputTokens;
        outputTokens = numberOrUndefined(json.response?.usage?.output_tokens) ?? outputTokens;
        finishReason = json.response?.status ?? finishReason;
        updateUsage();
      } else if (type === 'response.failed' || type === 'error') {
        throw new Error(json.response?.error?.message ?? json.error?.message ?? 'Provider stream failed');
      }
    } else {
      const type = event !== 'message' ? event : json.type;
      if (type === 'message_start') {
        inputTokens = numberOrUndefined(json.message?.usage?.input_tokens) ?? inputTokens;
        updateUsage();
      } else if (type === 'content_block_delta') {
        emit(stringOrEmpty(json.delta?.text));
      } else if (type === 'message_delta') {
        outputTokens = numberOrUndefined(json.usage?.output_tokens) ?? outputTokens;
        finishReason = json.delta?.stop_reason ?? finishReason;
        updateUsage();
      } else if (type === 'message_stop') {
        break;
      } else if (type === 'error') {
        throw new Error(json.error?.message ?? 'Provider stream failed');
      }
    }
  }
  return { usage: { inputTokens, outputTokens }, text, finishReason };
}

function usageJson(usage: Usage, format: 'openai' | 'anthropic') {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (format === 'anthropic') return { input_tokens: input, output_tokens: output };
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function formatOpenAIChat(result: UpstreamResult, model: string): Json {
  return {
    id: shortId('chatcmpl-'),
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: result.finishReason === 'length' ? 'length' : 'stop',
      },
    ],
    usage: usageJson(result.usage, 'openai'),
  };
}

export function formatOpenAIResponses(result: UpstreamResult, model: string): Json {
  const text = result.text;
  const input = result.usage.inputTokens ?? 0;
  const output = result.usage.outputTokens ?? 0;
  return {
    id: shortId('resp_'),
    object: 'response',
    created_at: nowSeconds(),
    status: 'completed',
    model,
    output: [
      {
        id: shortId('msg_'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    output_text: text,
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  };
}

export function formatAnthropic(result: UpstreamResult, model: string): Json {
  const stop = result.finishReason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: shortId('msg_'),
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: result.text }],
    stop_reason: stop,
    stop_sequence: null,
    usage: usageJson(result.usage, 'anthropic'),
  };
}

export function formatByIncoming(format: IncomingFormat, result: UpstreamResult, model: string): Json {
  if (format === 'openai_chat') return formatOpenAIChat(result, model);
  if (format === 'openai_responses') return formatOpenAIResponses(result, model);
  return formatAnthropic(result, model);
}

function sse(data: Json, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

export interface StreamFormatter {
  start(): string;
  delta(text: string): string;
  finish(usage: Usage, finishReason?: string): string;
  error(message: string): string;
}

class OpenAIChatStream implements StreamFormatter {
  readonly id = shortId('chatcmpl-');
  readonly created = nowSeconds();
  constructor(readonly model: string) {}
  start(): string {
    return sse({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
  }
  delta(text: string): string {
    return sse({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
  }
  finish(usage: Usage, finishReason?: string): string {
    const finish = finishReason === 'length' ? 'length' : 'stop';
    const last = sse({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    });
    const usageChunk = sse({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [],
      usage: usageJson(usage, 'openai'),
    });
    return `${last}${usageChunk}data: [DONE]\n\n`;
  }
  error(message: string): string {
    return `${sse({ error: { message, type: 'server_error' } })}data: [DONE]\n\n`;
  }
}

class ResponsesStream implements StreamFormatter {
  readonly responseId = shortId('resp_');
  readonly itemId = shortId('msg_');
  readonly createdAt = nowSeconds();
  private text = '';
  constructor(readonly model: string) {}

  private responseObject(status: string, usage?: Usage): Json {
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output:
        status === 'completed'
          ? [
              {
                id: this.itemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: this.text, annotations: [] }],
              },
            ]
          : [],
      ...(status === 'completed' ? { output_text: this.text } : {}),
      ...(usage ? { usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } : {}),
    };
  }

  start(): string {
    return [
      sse({ type: 'response.created', response: this.responseObject('in_progress') }, 'response.created'),
      sse(
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: this.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        },
        'response.output_item.added',
      ),
      sse(
        {
          type: 'response.content_part.added',
          item_id: this.itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        'response.content_part.added',
      ),
    ].join('');
  }

  delta(text: string): string {
    this.text += text;
    return sse(
      {
        type: 'response.output_text.delta',
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      'response.output_text.delta',
    );
  }

  finish(usage: Usage): string {
    return [
      sse(
        {
          type: 'response.output_text.done',
          item_id: this.itemId,
          output_index: 0,
          content_index: 0,
          text: this.text,
        },
        'response.output_text.done',
      ),
      sse(
        {
          type: 'response.content_part.done',
          item_id: this.itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: this.text, annotations: [] },
        },
        'response.content_part.done',
      ),
      sse(
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: this.itemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: this.text, annotations: [] }],
          },
        },
        'response.output_item.done',
      ),
      sse(
        { type: 'response.completed', response: this.responseObject('completed', usage) },
        'response.completed',
      ),
    ].join('');
  }

  error(message: string): string {
    return sse({ type: 'error', error: { type: 'server_error', message } }, 'error');
  }
}

class AnthropicStream implements StreamFormatter {
  readonly id = shortId('msg_');
  constructor(readonly model: string) {}
  start(): string {
    return [
      sse(
        {
          type: 'message_start',
          message: {
            id: this.id,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        'message_start',
      ),
      sse(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        'content_block_start',
      ),
    ].join('');
  }
  delta(text: string): string {
    return sse(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      'content_block_delta',
    );
  }
  finish(usage: Usage, finishReason?: string): string {
    const stop = finishReason === 'length' ? 'max_tokens' : 'end_turn';
    return [
      sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
      sse(
        {
          type: 'message_delta',
          delta: { stop_reason: stop, stop_sequence: null },
          usage: usageJson(usage, 'anthropic'),
        },
        'message_delta',
      ),
      sse({ type: 'message_stop' }, 'message_stop'),
    ].join('');
  }
  error(message: string): string {
    return sse({ type: 'error', error: { type: 'server_error', message } }, 'error');
  }
}

export function makeStreamFormatter(format: IncomingFormat, model: string): StreamFormatter {
  if (format === 'openai_chat') return new OpenAIChatStream(model);
  if (format === 'openai_responses') return new ResponsesStream(model);
  return new AnthropicStream(model);
}
