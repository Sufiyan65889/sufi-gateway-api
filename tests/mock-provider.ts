import http from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 4010);

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { resolve({}); }
    });
  });
}

function sse(res: http.ServerResponse, event: string | null, data: unknown) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const auth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '');
  if (auth.includes('bad-key')) {
    return json(res, 401, { error: { message: 'Invalid provider key', type: 'authentication_error' } });
  }
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const body = await readBody(req);

  if (url.pathname.endsWith('/models')) {
    return json(res, 200, {
      object: 'list',
      data: [
        { id: 'mock-chat', object: 'model', owned_by: 'mock', context_length: 128000, top_provider: { max_completion_tokens: 4096 } },
        { id: 'mock-vision', object: 'model', owned_by: 'mock', context_length: 32000 },
      ],
    });
  }

  if (url.pathname.endsWith('/chat/completions')) {
    const text = 'Hello from the mock provider.';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, null, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' } }] });
      for (const piece of ['Hello', ' from', ' mock']) {
        sse(res, null, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: piece } }] });
      }
      sse(res, null, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return json(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  if (url.pathname.endsWith('/responses')) {
    const text = 'Hello from the mock Responses API.';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, 'response.created', { type: 'response.created', response: { id: 'resp-mock', object: 'response', status: 'in_progress', model: body.model, output: [] } });
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', delta: text });
      sse(res, 'response.completed', { type: 'response.completed', response: { id: 'resp-mock', object: 'response', status: 'completed', model: body.model, output: [], output_text: text, usage: { input_tokens: 10, output_tokens: 5 } } });
      return res.end();
    }
    return json(res, 200, {
      id: 'resp-mock',
      object: 'response',
      status: 'completed',
      model: body.model,
      output_text: text,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  }

  if (url.pathname.endsWith('/messages')) {
    const text = 'Hello from the mock Anthropic API.';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, 'message_start', { type: 'message_start', message: { id: 'msg-mock', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      sse(res, 'message_stop', { type: 'message_stop' });
      return res.end();
    }
    return json(res, 200, {
      id: 'msg-mock',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }

  json(res, 404, { error: { message: `Mock provider has no route ${url.pathname}` } });
});

server.listen(port, '127.0.0.1', () => console.log(`Mock provider on http://127.0.0.1:${port}`));
