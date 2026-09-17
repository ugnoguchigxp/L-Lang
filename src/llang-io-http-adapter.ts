import { isIP } from "node:net";
import { LBytes } from "./llang-effects-values";

export type HttpBodyHandle = Readonly<{ id: number; generation: number }>;
export type HttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: HttpBodyHandle;
}>;
type BodyResource = {
  generation: number;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  queued: Uint8Array;
  done: boolean;
  reading: boolean;
};

const LOOPBACK_V4 = /^127\./;
const safeAddress = (address: string) =>
  LOOPBACK_V4.test(address) ||
  address === "::1" ||
  address === "0:0:0:0:0:0:0:1";

export class LoopbackHttpAdapter {
  readonly #bodies = new Map<number, BodyResource>();
  #nextId = 1;

  constructor(
    readonly origins: ReadonlySet<string>,
    readonly credentialHeaders: ReadonlyMap<
      string,
      Readonly<Record<string, string>>
    > = new Map(),
  ) {}

  async request(options: {
    url: string;
    method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Readonly<Record<string, string>>;
    body?: LBytes;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<HttpResponse> {
    const url = this.#url(options.url);
    if (!this.origins.has(url.origin))
      throw new Error("PERMISSION_DENIED: origin");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!isIP(hostname) || !safeAddress(hostname))
      throw new Error("PERMISSION_DENIED: address");
    if (options.body && options.body.length > 1024 * 1024)
      throw new Error("RESOURCE_LIMIT: request body");
    const headers = new Headers();
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const lower = name.toLowerCase();
      if (
        ["authorization", "proxy-authorization", "host", "cookie"].includes(
          lower,
        )
      )
        throw new Error("PERMISSION_DENIED: credential header");
      headers.set(lower, value);
    }
    for (const [name, value] of Object.entries(
      this.credentialHeaders.get(url.origin) ?? {},
    ))
      headers.set(name, value);
    const controller = new AbortController(),
      timeout = setTimeout(
        () => controller.abort("timeout"),
        options.timeoutMs ?? 10_000,
      ),
      abort = () => controller.abort(options.signal?.reason ?? "cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        ...(options.body
          ? { body: options.body.toUint8Array() as unknown as BodyInit }
          : {}),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          controller.signal.reason === "timeout" ? "TIMEOUT" : "CANCELLED",
        );
      throw new Error(
        `CONNECTION: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
    const id = this.#nextId++,
      generation = 1,
      body = response.body;
    if (!body) {
      const empty = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.close();
        },
      });
      this.#bodies.set(id, {
        generation,
        reader: empty.getReader(),
        queued: new Uint8Array(),
        done: false,
        reading: false,
      });
    } else
      this.#bodies.set(id, {
        generation,
        reader: body.getReader(),
        queued: new Uint8Array(),
        done: false,
        reading: false,
      });
    return Object.freeze({
      status: response.status,
      headers: Object.freeze(Object.fromEntries(response.headers)),
      body: Object.freeze({ id, generation }),
    });
  }

  async readChunk(
    handle: HttpBodyHandle,
    maximum = 64 * 1024,
  ): Promise<{ eof: boolean; bytes: LBytes }> {
    const resource = this.#get(handle);
    if (resource.reading) throw new Error("STREAM_READ_PENDING");
    if (resource.done && !resource.queued.length)
      return { eof: true, bytes: LBytes.from([]) };
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64 * 1024)
      throw new Error("RESOURCE_LIMIT: chunk");
    resource.reading = true;
    try {
      while (resource.queued.length < maximum && !resource.done) {
        const next = await resource.reader.read();
        if (next.done) {
          resource.done = true;
          break;
        }
        if (next.value.length) {
          const joined = new Uint8Array(
            resource.queued.length + next.value.length,
          );
          joined.set(resource.queued);
          joined.set(next.value, resource.queued.length);
          resource.queued = joined;
        }
        if (resource.queued.length) break;
      }
      const count = Math.min(maximum, resource.queued.length),
        output = resource.queued.slice(0, count);
      resource.queued = resource.queued.slice(count);
      return {
        eof: resource.done && output.length === 0,
        bytes: LBytes.from(output),
      };
    } finally {
      resource.reading = false;
    }
  }

  async close(handle: HttpBodyHandle): Promise<void> {
    const resource = this.#bodies.get(handle.id);
    if (!resource || resource.generation !== handle.generation) return;
    this.#bodies.delete(handle.id);
    await resource.reader.cancel().catch(() => undefined);
  }

  #url(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("INVALID_URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("INVALID_URL");
    return url;
  }

  #get(handle: HttpBodyHandle): BodyResource {
    const resource = this.#bodies.get(handle.id);
    if (!resource || resource.generation !== handle.generation)
      throw new Error("STALE_RESOURCE_HANDLE");
    return resource;
  }
}
