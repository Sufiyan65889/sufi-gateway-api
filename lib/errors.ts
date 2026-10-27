export type ErrorFormat = 'openai' | 'anthropic';

export class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code?: string;
  readonly headers?: Record<string, string>;

  constructor(status: number, message: string, type = 'invalid_request_error', code?: string, headers?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.headers = headers;
  }
}

export function openAiError(error: HttpError) {
  return {
    error: {
      message: error.message,
      type: error.type,
      code: error.code ?? null,
    },
  };
}

export function anthropicError(error: HttpError) {
  return {
    type: 'error',
    error: {
      type: error.type === 'authentication_error' ? 'authentication_error' : error.type,
      message: error.message,
    },
  };
}
