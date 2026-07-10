/**
 * Shared TrueNAS REST API v2.0 transport for the @keeb/truenas extension.
 *
 * Every domain model (system, storage, sharing, …) constructs a
 * {@link TrueNasClient} from its `baseUrl` + `apiKey` global arguments and
 * speaks to the box through it. Keeping the transport in one module means auth,
 * error shaping, and URL joining are defined once and shared by every model.
 *
 * This file intentionally exports no `model`, so the extension loader skips it
 * as a model definition while still bundling it into the models that import it.
 *
 * @module
 */
import { z } from "npm:zod@4";

/**
 * Connection settings shared by every TrueNAS domain model. `baseUrl` points at
 * the REST v2.0 root (e.g. `http://10.0.0.59/api/v2.0`); `apiKey` is a TrueNAS
 * API key resolved from a vault at runtime and sent as a Bearer token.
 */
export const ConnectionSchema = z.object({
  baseUrl: z.string().url().describe(
    "TrueNAS REST API v2.0 root, e.g. http://10.0.0.59/api/v2.0",
  ),
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "TrueNAS API key (Bearer token), sourced from a vault",
  ),
});

/** Parsed connection settings for {@link TrueNasClient}. */
export type Connection = z.infer<typeof ConnectionSchema>;

/** HTTP verbs used against the TrueNAS REST API. */
type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Thin, typed wrapper over the TrueNAS SCALE REST API v2.0.
 *
 * Handles Bearer auth, JSON encoding, URL joining, and error shaping so domain
 * models only deal in endpoint paths and typed payloads. Not tied to any
 * particular resource — models layer their own schemas on top of {@link get},
 * {@link post}, {@link put}, and {@link del}.
 */
export class TrueNasClient {
  readonly #base: string;
  readonly #apiKey: string;
  readonly #signal?: AbortSignal;

  constructor(conn: Connection, signal?: AbortSignal) {
    // Normalize to a bare root without a trailing slash so path joining is
    // predictable regardless of how the caller wrote baseUrl.
    this.#base = conn.baseUrl.replace(/\/+$/, "");
    this.#apiKey = conn.apiKey;
    this.#signal = signal;
  }

  /** GET a resource collection or item; returns parsed JSON (or null on 204). */
  get<T = unknown>(path: string): Promise<T> {
    return this.#request<T>("GET", path);
  }

  /** POST a JSON body to create or invoke an action. */
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.#request<T>("POST", path, body);
  }

  /** PUT a JSON body to update an existing item. */
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.#request<T>("PUT", path, body);
  }

  /** DELETE an item; TrueNAS accepts an optional JSON options body. */
  del<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.#request<T>("DELETE", path, body);
  }

  async #request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const url = `${this.#base}/${path.replace(/^\/+/, "")}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.#signal,
    });

    const text = await res.text();
    if (!res.ok) {
      // Surface the TrueNAS error body — it carries the middleware's own
      // validation messages, which are far more useful than a bare status.
      throw new Error(
        `TrueNAS ${method} ${path} -> ${res.status} ${res.statusText}: ${
          text.slice(0, 2000)
        }`,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

/**
 * Turn a TrueNAS id (which may contain `/`, `@`, or `:`) into a safe swamp data
 * instance name. Instance names map directly to on-disk paths, so anything
 * outside `[A-Za-z0-9._-]` is collapsed to `_`. The real id is preserved in the
 * resource's `attributes.id`, so CEL queries still match on the true value.
 */
export function slug(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * TrueNAS wraps timestamps as `{ "$date": <epoch-ms> }`. Convert to an ISO
 * string, or `null` when absent, so resource schemas can store a plain string.
 */
export function isoFromTrueNasDate(
  v: { $date?: number } | null | undefined,
): string | null {
  if (v && typeof v.$date === "number") return new Date(v.$date).toISOString();
  return null;
}
