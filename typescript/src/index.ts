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
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(this.clock()));
    const nonce = this.nonceFactory();
    if (!nonce || nonce.length > 128) throw new Error("nonce must contain 1 to 128 characters");
    const message = `${timestamp}\n${nonce}\n${body}`;
    const signature = createHmac("sha256", this.appSecret).update(message, "utf8").digest("hex");
    const url = `${this.baseUrl}/api/v2/signal-sources/push/${encodeURIComponent(this.appId)}/events`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
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
    } catch (error) {
      throw new SignalSourceError(`signal push request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    const raw = await response.text();
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw new SignalSourceError("signal push returned invalid JSON", response.status, raw);
    }
    if (!response.ok) {
      throw new SignalSourceError(errorMessage(response.status, document), response.status, raw);
    }
    if (isRecord(document) && isRecord(document.data)) return document.data as PushResponse;
    return isRecord(document) ? document as PushResponse : { value: document };
  }
}

function validateEvent(event: NewsItem): void {
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

function errorMessage(status: number, document: unknown): string {
  const message = isRecord(document) && (document.message ?? document.error);
  return `signal push failed (${status})${typeof message === "string" ? `: ${message}` : ""}`;
}
