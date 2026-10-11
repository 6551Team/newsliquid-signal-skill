import { createHmac, randomUUID } from "node:crypto";

export const DEFAULT_BASE_URL = "https://news-api.newsliquid.com";

export interface Coin {
  symbol: string;
  market_type?: string;
  chain?: string;
  contract_address?: string;
  pool?: string;
  match?: string[];
  score?: number;
  signal?: string;
  grade?: string;
  market_title?: string;
  event_slug?: string;
  market_slug?: string;
  expired?: boolean;
  [key: string]: unknown;
}

export interface NewsItem {
  meta?: Record<string, string | number | boolean>;
  id?: string;
  text: string;
  ts: string;
  description?: string;
  link?: string;
  source?: string;
  coins?: Coin[];
  tags?: Record<string, unknown> | unknown[];
  score?: number;
  signal?: string;
  [key: string]: unknown;
}

export interface PushResponse {
  dbNewsId?: string;
  queued?: boolean;
  [key: string]: unknown;
}

export interface SignalSourceMetaField {
  key: string;
  label: string;
  type: "enum" | "number" | "boolean" | "text";
  options?: string[];
  /** Only for compatibility with older number fields. */
  operator?: "in" | "gt" | "gte" | "lt" | "lte" | "eq" | "contains";
}

/** Omitted fields remain unchanged. */
export interface SignalSourceUpdate {
  name?: string;
  description?: string;
  website?: string;
  visibility?: "private" | "public";
  monetizationType?: "free" | "paid";
  quotaAmount?: number | string;
  billingPeriod?: "one_time" | "monthly";
  metaSchema?: SignalSourceMetaField[];
}

export interface SignalSourceResponse {
  id: number;
  name: string;
  description: string;
  website: string;
  visibility: "private" | "public";
  monetizationType: "free" | "paid";
  quotaAmount: string | number;
  billingPeriod: "one_time" | "monthly";
  metaSchema: SignalSourceMetaField[] | null;
  reviewStatus: string;
  [key: string]: unknown;
}

export interface SignalSourceClientOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  nonceFactory?: () => string;
}

export class SignalSourceError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "SignalSourceError";
    this.status = status;
    this.body = body;
  }
}

export class SignalSourceClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly clock: () => number;
  private readonly nonceFactory: () => string;

  constructor(options: SignalSourceClientOptions) {
    if (!options.appId || !options.appSecret) {
      throw new Error("appId and appSecret are required");
    }
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.requestFetch = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.nonceFactory = options.nonceFactory ?? randomUUID;
    if (!this.requestFetch) throw new Error("global fetch is unavailable; provide options.fetch");
  }

  async push(event: NewsItem): Promise<PushResponse> {
    validateEvent(event);
    return this.request<PushResponse>(`/api/v2/signal-sources/push/${encodeURIComponent(this.appId)}/events`, event, "push");
  }

  /** Edit the source bound to these credentials using the owner's existing rules. */
  async update(input: SignalSourceUpdate): Promise<SignalSourceResponse> {
    if (!isRecord(input)) throw new Error("source configuration must be an object");
    return this.request<SignalSourceResponse>(`/api/v2/signal-sources/apps/${encodeURIComponent(this.appId)}`, input, "update");
  }

  private async request<T extends Record<string, unknown>>(path: string, payload: object, operation: "push" | "update"): Promise<T> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(this.clock()));
    const nonce = this.nonceFactory();
    if (!nonce || nonce.length > 128) throw new Error("nonce must contain 1 to 128 characters");
    const marker = operation === "update" ? "signal-source:update\n" : "";
    const message = `${timestamp}\n${nonce}\n${marker}${body}`;
    const signature = createHmac("sha256", this.appSecret).update(message, "utf8").digest("hex");
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let raw: string;
    try {
      response = await this.requestFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signal-timestamp": timestamp,
          "x-signal-nonce": nonce,
          "x-signal-signature": signature,
        },
        body,
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (error) {
      throw new SignalSourceError(`signal ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw new SignalSourceError(`signal ${operation} returned invalid JSON`, response.status, raw);
    }
    if (!response.ok) {
      throw new SignalSourceError(errorMessage(response.status, document, operation), response.status, raw);
    }
    if (isRecord(document) && isRecord(document.data)) return document.data as T;
    return (isRecord(document) ? document : { value: document }) as T;
  }
}

function validateEvent(event: NewsItem): void {
  if (event.meta !== undefined && !isRecord(event.meta)) throw new Error("meta must be an object");
  for (const field of ["text", "ts"] as const) {
    if (typeof event[field] !== "string" || !event[field].trim()) throw new Error(`${field} is required`);
  }
  if (event.id !== undefined && event.id.length > 256) throw new Error("id must be at most 256 characters");
  if (event.score !== undefined && (!Number.isInteger(event.score) || event.score < 0 || event.score > 100)) {
    throw new Error("score must be an integer between 0 and 100");
  }
  if (event.tags !== undefined && (typeof event.tags !== "object" || event.tags === null || (!Array.isArray(event.tags) && typeof event.tags !== "object"))) {
    throw new Error("tags must be an object or array");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(status: number, document: unknown, operation: string): string {
  const message = isRecord(document) && (document.message ?? document.error);
  return `signal ${operation} failed (${status})${typeof message === "string" ? `: ${message}` : ""}`;
}
