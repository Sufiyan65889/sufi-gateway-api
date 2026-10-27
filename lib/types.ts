export type Protocol = 'openai_chat' | 'openai_responses' | 'anthropic';
export type IncomingFormat = 'openai_chat' | 'openai_responses' | 'anthropic';
export type Role = 'system' | 'user' | 'assistant';
export type RoutingMode = 'ordered' | 'random';

export type ImagePart = {
  mime?: string;
  data?: string;
  url?: string;
};

export type ChatMessage = {
  role: Role;
  content: string;
  images?: ImagePart[];
};

export type CanonicalRequest = {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream: boolean;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type UpstreamResult = {
  text: string;
  usage: Usage;
  raw?: unknown;
  finishReason?: string;
};

export type ProviderRecord = {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type ApiKeyRecord = {
  id: string;
  label: string;
  keyHash: string;
  keyPrefix: string;
  keyLast4: string;
  providerId: string;
  active: boolean;
  routing: RoutingMode;
  streaming: boolean;
  rpm: number | null;
  rpd: number | null;
  tpd: number | string | null;
  allowedModels: string[];
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  revokedAt: Date | string | null;
};

export type ApiKeyWithProvider = ApiKeyRecord & {
  providerName: string;
  providerProtocol: Protocol;
  providerBaseUrl: string;
};

export type CredentialRecord = {
  id: string;
  apiKeyId: string;
  label: string;
  secretCiphertext: string;
  secretIv: string;
  secretTag: string;
  secretHash: string;
  secretLast4: string;
  active: boolean;
  cooldownUntil: Date | string | null;
  lastStatus: string | null;
  lastCheckedAt: Date | string | null;
  createdAt: Date | string;
};

export type ModelRecord = {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string | null;
  ownedBy: string | null;
  contextWindow: number | string | null;
  maxOutput: number | string | null;
  enabled: boolean;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type SettingsRecord = {
  id: number;
  defaultRpm: number | null;
  defaultRpd: number | null;
  defaultTpd: number | string | null;
  defaultStreaming: boolean;
  timezone: string;
};

export type UpstreamModel = {
  id: string;
  displayName?: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutput?: number;
};

export type StreamUsage = Usage;
