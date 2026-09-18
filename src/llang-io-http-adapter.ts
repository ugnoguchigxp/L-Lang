import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { LBytes } from "./llang-effects-values";

export type HttpBodyHandle = Readonly<{ id: number; generation: number }>;
export type HttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: HttpBodyHandle;
}>;
export type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type HttpNetworkPolicy = Readonly<{
  allowPublic?: boolean;
  allowedAddresses?: readonly string[];
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}>;

type BodyReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};
type BodyResource = {
  generation: number;
  reader: BodyReader;
  queued: Uint8Array;
  done: boolean;
  reading: boolean;
  cancelReason?: "TIMEOUT" | "CANCELLED";
  cleanup(): void;
};

const deniedByDefault = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  deniedByDefault.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  deniedByDefault.addSubnet(network, prefix, "ipv6");

const addressType = (family: 4 | 6) => (family === 4 ? "ipv4" : "ipv6");

const explicitAddresses = (entries: readonly string[]) => {
  const list = new BlockList();
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/"),
      address = slash < 0 ? entry : entry.slice(0, slash),
      family = isIP(address);
    if (!family) throw new Error("INVALID_NETWORK_GRANT");
    const normalizedFamily: 4 | 6 = family === 6 ? 6 : 4;
    if (slash < 0) list.addAddress(address, addressType(normalizedFamily));
    else {
      const prefix = Number(entry.slice(slash + 1));
      if (
        !Number.isInteger(prefix) ||
        prefix < 0 ||
        prefix > (normalizedFamily === 4 ? 32 : 128)
      )
        throw new Error("INVALID_NETWORK_GRANT");
      list.addSubnet(address, prefix, addressType(normalizedFamily));
    }
  }
  return list;
};

const systemResolve = async (hostname: string): Promise<ResolvedAddress[]> => {
  const literal = isIP(hostname);
  if (literal) return [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

const nodeReader = (response: IncomingMessage): BodyReader => {
  const iterator = response[Symbol.asyncIterator]();
  return {
    async read() {
      const next = await iterator.next();
      if (next.done) return { done: true };
      const value = next.value as Uint8Array;
      return {
        done: false,
        value: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      };
    },
    async cancel() {
      response.destroy();
    },
  };
};

export class HttpAdapter {
  readonly #bodies = new Map<number, BodyResource>();
  readonly #explicit: BlockList;
  readonly #allowPublic: boolean;
  readonly #resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  #nextId = 1;

  constructor(
    readonly origins: ReadonlySet<string>,
    readonly credentialHeaders: ReadonlyMap<
      string,
      Readonly<Record<string, string>>
    > = new Map(),
    policy: HttpNetworkPolicy = {},
  ) {
    this.#allowPublic = policy.allowPublic ?? true;
    this.#explicit = explicitAddresses(policy.allowedAddresses ?? []);
    this.#resolve = policy.resolve ?? systemResolve;
  }

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
    if (options.body && options.body.length > 1024 * 1024)
      throw new Error("RESOURCE_LIMIT: request body");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const lower = name.toLowerCase();
      if (
        ["authorization", "proxy-authorization", "host", "cookie"].includes(
          lower,
        )
      )
        throw new Error("PERMISSION_DENIED: credential header");
      headers[lower] = value;
    }
    for (const [name, value] of Object.entries(
      this.credentialHeaders.get(url.origin) ?? {},
    ))
      headers[name.toLowerCase()] = value;

    const hostname = url.hostname.replace(/^\[|\]$/g, ""),
      addresses = await this.#resolve(hostname),
      selected = addresses.find((item) => this.#allowed(item));
    if (!selected) throw new Error("PERMISSION_DENIED: address");
    const response = await this.#send(
        url,
        selected,
        options.method,
        headers,
        options.body,
        options.timeoutMs ?? 10_000,
        options.signal,
      ),
      id = this.#nextId++,
      generation = 1,
      resource: BodyResource = {
        generation,
        reader: nodeReader(response),
        queued: new Uint8Array(),
        done: false,
        reading: false,
        cleanup: () => undefined,
      },
      cancelBody = (reason: "TIMEOUT" | "CANCELLED") => {
        if (resource.done || resource.cancelReason) return;
        resource.cancelReason = reason;
        response.destroy();
      },
      bodyTimer = setTimeout(
        () => cancelBody("TIMEOUT"),
        options.timeoutMs ?? 10_000,
      ),
      abortBody = () => cancelBody("CANCELLED");
    resource.cleanup = () => {
      clearTimeout(bodyTimer);
      options.signal?.removeEventListener("abort", abortBody);
    };
    options.signal?.addEventListener("abort", abortBody, { once: true });
    if (options.signal?.aborted) abortBody();
    this.#bodies.set(id, resource);
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers))
      if (value !== undefined)
        responseHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
    return Object.freeze({
      status: response.statusCode ?? 0,
      headers: Object.freeze(responseHeaders),
      body: Object.freeze({ id, generation }),
    });
  }

  async readChunk(
    handle: HttpBodyHandle,
    maximum = 64 * 1024,
  ): Promise<{ eof: boolean; bytes: LBytes }> {
    const resource = this.#get(handle);
    if (resource.cancelReason) throw new Error(resource.cancelReason);
    if (resource.reading) throw new Error("STREAM_READ_PENDING");
    if (resource.done && !resource.queued.length)
      return { eof: true, bytes: LBytes.from([]) };
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64 * 1024)
      throw new Error("RESOURCE_LIMIT: chunk");
    resource.reading = true;
    try {
      while (resource.queued.length < maximum && !resource.done) {
        let next: Awaited<ReturnType<BodyReader["read"]>>;
        try {
          next = await resource.reader.read();
        } catch (error) {
          if (resource.cancelReason) throw new Error(resource.cancelReason);
          throw new Error(
            `CONNECTION: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (next.done) {
          resource.done = true;
          resource.cleanup();
          break;
        }
        if (next.value?.length) {
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
    resource.cleanup();
    await resource.reader.cancel().catch(() => undefined);
  }

  #allowed(item: ResolvedAddress): boolean {
    if (isIP(item.address) !== item.family) return false;
    const type = addressType(item.family);
    if (this.#explicit.check(item.address, type)) return true;
    return this.#allowPublic && !deniedByDefault.check(item.address, type);
  }

  async #send(
    url: URL,
    address: ResolvedAddress,
    method: string,
    headers: Readonly<Record<string, string>>,
    body: LBytes | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<IncomingMessage> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("INVALID_TIMEOUT");
    if (signal?.aborted) throw new Error("CANCELLED");
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all)
          callback(null, [
            { address: address.address, family: address.family },
          ]);
        else callback(null, address.address, address.family);
      },
      requestOptions: RequestOptions = {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        lookup: pinnedLookup,
      },
      request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return await new Promise<IncomingMessage>((resolve, reject) => {
      let timedOut = false,
        settled = false;
      let call: ReturnType<typeof httpRequest>;
      const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
        fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
        abort = () => {
          call.destroy();
          fail(new Error("CANCELLED"));
        },
        timer = setTimeout(() => {
          timedOut = true;
          call.destroy();
          fail(new Error("TIMEOUT"));
        }, timeoutMs);
      call = request(requestOptions, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      });
      signal?.addEventListener("abort", abort, { once: true });
      call.once("socket", (socket) => {
        socket.once(
          url.protocol === "https:" ? "secureConnect" : "connect",
          () => {
            const remote = socket.remoteAddress;
            if (remote && remote !== address.address)
              call.destroy(new Error("PERMISSION_DENIED: connected address"));
          },
        );
      });
      call.once("error", (error) => {
        if (timedOut || error.message === "TIMEOUT") fail(new Error("TIMEOUT"));
        else if (signal?.aborted || error.message === "CANCELLED")
          fail(new Error("CANCELLED"));
        else fail(new Error(`CONNECTION: ${error.message}`));
      });
      if (body) call.write(body.toUint8Array());
      call.end();
    });
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

export class LoopbackHttpAdapter extends HttpAdapter {
  constructor(
    origins: ReadonlySet<string>,
    credentialHeaders: ReadonlyMap<
      string,
      Readonly<Record<string, string>>
    > = new Map(),
  ) {
    super(origins, credentialHeaders, {
      allowPublic: false,
      allowedAddresses: ["127.0.0.0/8", "::1"],
    });
  }
}
