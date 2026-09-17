import { ResourceLedger, type BudgetLimits } from "./llang-effects-contract";
import { StructuredTaskScope } from "./llang-effects-concurrency";
import { Decimal, LBytes, Utf8StreamDecoder } from "./llang-effects-values";
import type {
  LocalFileAdapter,
  FileResourceHandle,
} from "./llang-io-file-adapter";

type Order = {
  id: string;
  quantity: bigint;
  unit: Decimal;
};
export type EnrichedOrder = Readonly<{
  id: string;
  quantity: string;
  total: { coefficient: string; scale: number };
}>;

const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_ORDER");
  const object = value as Record<string, unknown>,
    actual = Object.keys(object);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    throw new Error("INVALID_ORDER");
  return object;
};

const parseOrder = (line: string): Order => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("INVALID_ORDER_JSON");
  }
  const object = exact(parsed, ["id", "quantity", "unit"]),
    unit = exact(object.unit, ["coefficient", "scale"]);
  if (
    typeof object.id !== "string" ||
    !object.id ||
    typeof object.quantity !== "string" ||
    !/^[1-9][0-9]*$/.test(object.quantity) ||
    typeof unit.coefficient !== "string" ||
    !/^-?(?:0|[1-9][0-9]*)$/.test(unit.coefficient) ||
    !Number.isInteger(unit.scale)
  )
    throw new Error("INVALID_ORDER");
  const quantity = BigInt(object.quantity);
  if (quantity > 2147483647n) throw new Error("INVALID_ORDER");
  return {
    id: object.id,
    quantity,
    unit: new Decimal(BigInt(unit.coefficient), Number(unit.scale)),
  };
};

export async function runModuleIoPipeline(options: {
  adapter: LocalFileAdapter;
  input: string;
  output: string;
  outputScale: number;
  enrich: (id: string, signal: AbortSignal) => Promise<Decimal>;
  signal?: AbortSignal;
  limits?: BudgetLimits;
}): Promise<{ processed: number; writtenBytes: number; committed: true }> {
  const limits = options.limits ?? {
      hostRequests: 1024,
      tasks: 1024,
      concurrentIo: 8,
      concurrentTasks: 4,
      openResources: 32,
      streams: 32,
      sentBytes: 64 * 1024 * 1024,
      receivedBytes: 64 * 1024 * 1024,
      memoryBytes: 32 * 1024 * 1024,
      fuel: 10_000_000,
    },
    ledger = new ResourceLedger(limits),
    tasks = new StructuredTaskScope(
      ledger,
      Math.min(4, limits.concurrentTasks),
    ),
    decoder = new Utf8StreamDecoder();
  let input: FileResourceHandle | undefined,
    output: FileResourceHandle | undefined,
    pending = "",
    writtenBytes = 0;
  const submit = (line: string) => {
    const order = parseOrder(line);
    tasks.spawn(async (taskSignal) => {
      if (options.signal?.aborted || taskSignal.aborted)
        throw new Error("CANCELLED");
      const fee = await options.enrich(order.id, taskSignal),
        subtotal = order.unit.multiply(
          new Decimal(order.quantity, 0),
          options.outputScale,
          "half-even",
        ),
        total = subtotal.add(fee.rescale(options.outputScale, "half-even"));
      return {
        id: order.id,
        quantity: order.quantity.toString(),
        total: total.toJSON(),
      } satisfies EnrichedOrder;
    });
  };
  try {
    input = await options.adapter.openRead(options.input);
    while (true) {
      if (options.signal?.aborted) throw new Error("CANCELLED");
      const chunk = await options.adapter.readChunk(input);
      if (chunk.eof) break;
      pending += decoder.push(chunk.bytes);
      if (new TextEncoder().encode(pending).length > 1024 * 1024)
        throw new Error("RESOURCE_LIMIT: JSON line");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) submit(line);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.finish();
    if (pending) submit(pending);
    await options.adapter.close(input);
    input = undefined;
    const results = await tasks.joinAll<EnrichedOrder>();
    output = await options.adapter.openWrite(options.output, {
      replace: false,
    });
    for (const result of results) {
      const bytes = LBytes.encodeUtf8(`${JSON.stringify(result)}\n`);
      ledger.consume("sentBytes", bytes.length);
      writtenBytes += await options.adapter.writeChunk(output, bytes);
    }
    await options.adapter.commit(output);
    output = undefined;
    return { processed: results.length, writtenBytes, committed: true };
  } catch (error) {
    tasks.cancel();
    if (input) await options.adapter.close(input).catch(() => undefined);
    if (output) await options.adapter.abort(output).catch(() => undefined);
    throw error;
  }
}
