import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpstreamPayload,
  consumeUpstreamStream,
  formatAnthropic,
  formatOpenAIChat,
  makeStreamFormatter,
  parseAnthropic,
  parseOpenAIChat,
  parseOpenAIResponses,
  parseUpstreamJson,
} from '../lib/adapters';

test('parses OpenAI chat text and images', () => {
  const req = parseOpenAIChat({
    model: 'test-model',
    messages: [
      { role: 'system', content: 'be nice' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
    max_tokens: 100,
    stream: true,
  });
  assert.equal(req.model, 'test-model');
  assert.equal(req.maxTokens, 100);
  assert.equal(req.messages[1].images?.[0].data, 'AAAA');
  assert.equal(req.stream, true);
});

test('parses Anthropic messages and builds Anthropic payload', () => {
  const req = parseAnthropic({
    model: 'claude-test',
    system: 'be kind',
    max_tokens: 512,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.equal(req.messages[0].role, 'system');
  const body = buildUpstreamPayload('anthropic', req, false);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.system, 'be kind');
});

test('parses Responses API input', () => {
  const req = parseOpenAIResponses({
    model: 'gpt-test',
    instructions: 'be brief',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  });
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[1].content, 'hello');
});

test('parses upstream OpenAI and Anthropic responses', () => {
  const openai = parseUpstreamJson('openai_chat', {
    choices: [{ message: { content: 'hey' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });
  assert.equal(openai.text, 'hey');
  assert.equal(openai.usage.inputTokens, 3);
  const anthropic = parseUpstreamJson('anthropic', {
    content: [{ type: 'text', text: 'yo' }],
    usage: { input_tokens: 5, output_tokens: 6 },
    stop_reason: 'end_turn',
  });
  assert.equal(anthropic.text, 'yo');
  assert.equal(anthropic.usage.outputTokens, 6);
});

test('formats all three incoming response shapes', () => {
  const chat = formatOpenAIChat({ text: 'hi', usage: { inputTokens: 1, outputTokens: 2 } }, 'm');
  assert.equal(chat.choices[0].message.content, 'hi');
  assert.equal(chat.usage.total_tokens, 3);
  const ant = formatAnthropic({ text: 'hi', usage: { inputTokens: 1, outputTokens: 2 } }, 'm');
  assert.equal(ant.content[0].text, 'hi');
  assert.equal(ant.usage.output_tokens, 2);
});

test('SSE formatters produce valid event names', () => {
  for (const format of ['openai_chat', 'openai_responses', 'anthropic'] as const) {
    const f = makeStreamFormatter(format, 'm');
    const start = f.start();
    const delta = f.delta('hello');
    const finish = f.finish({ inputTokens: 1, outputTokens: 2 });
    assert.ok(start.includes('data:'));
    assert.ok(delta.includes('hello'));
    assert.ok(finish.length > 10);
  }
});

test('consumes OpenAI SSE stream and usage', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  let text = '';
  let usage: any = {};
  const result = await consumeUpstreamStream('openai_chat', stream, (d) => { text += d; }, (u) => { usage = u; });
  assert.equal(text, 'hello');
  assert.equal(usage.outputTokens, 2);
  assert.equal(result.text, 'hello');
});
