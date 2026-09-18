import type { ResourceLedger } from "./llang-effects-contract";
import type { LBytes } from "./llang-effects-values";

export class RuntimeTaskFault extends Error {
  constructor(message: string) {
    super(message);
  }
}

type TaskRecord<T> = {
  index: number;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class StructuredTaskScope {
  readonly #queue: TaskRecord<unknown>[] = [];
  readonly #controllers = new Set<AbortController>();
  readonly #promises: Promise<unknown>[] = [];
  #running = 0;
  #closed = false;
  #fault: unknown;

  constructor(
    readonly ledger: ResourceLedger,
    readonly concurrency: number,
    readonly queueLimit = 1024,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("INVALID_CONCURRENCY");
  }

  spawn<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("TASK_SCOPE_CLOSED");
    if (this.#queue.length + this.#running >= this.queueLimit)
      throw new Error("RESOURCE_LIMIT: task queue");
    this.ledger.consume("tasks");
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const record: TaskRecord<T> = {
      index: this.#promises.length,
      run,
      resolve,
      reject,
    };
    this.#promises.push(promise);
    this.#queue.push(record as TaskRecord<unknown>);
    this.#drain();
    return promise;
  }

  async joinAll<T>(): Promise<T[]> {
    this.#closed = true;
    const settled = await Promise.allSettled(this.#promises);
    if (this.#fault) throw this.#fault;
    return settled.map((item) => {
      if (item.status === "rejected") throw item.reason;
      return item.value as T;
    });
  }

  cancel(reason = "cancelled"): void {
    if (this.#closed && !this.#running) return;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort(reason);
    for (const queued of this.#queue.splice(0))
      queued.reject(new Error("CANCELLED"));
  }

  #drain(): void {
    while (
      !this.#fault &&
      this.#running < this.concurrency &&
      this.#queue.length
    ) {
      const record = this.#queue.shift();
      if (!record) break;
      try {
        this.ledger.consume("concurrentTasks");
      } catch (error) {
        record.reject(error);
        continue;
      }
      this.#running += 1;
      const controller = new AbortController();
      this.#controllers.add(controller);
      void record
        .run(controller.signal)
        .then(record.resolve, (error) => {
          record.reject(error);
          if (error instanceof RuntimeTaskFault) {
            this.#fault = error;
            for (const sibling of this.#controllers)
              if (sibling !== controller) sibling.abort("sibling fault");
            for (const queued of this.#queue.splice(0)) queued.reject(error);
          }
        })
        .finally(() => {
          this.#controllers.delete(controller);
          this.#running -= 1;
          this.ledger.release("concurrentTasks");
          this.#drain();
        });
    }
  }
}

type ReadResult =
  | Readonly<{ eof: false; bytes: LBytes }>
  | Readonly<{ eof: true }>;

export class BoundedPullStream {
  #pendingRead = false;
  #closed = false;
  #producerClosed = false;
  #bytes = 0;

  constructor(
    readonly pull: (signal: AbortSignal) => Promise<ReadResult>,
    readonly closeProducer: () => void | Promise<void>,
    readonly maximumChunkBytes = 64 * 1024,
  ) {}

  async read(signal = new AbortController().signal): Promise<ReadResult> {
    if (this.#pendingRead) throw new Error("STREAM_READ_PENDING");
    if (this.#closed) return { eof: true };
    this.#pendingRead = true;
    try {
      const result = await this.pull(signal);
      if (!result.eof) {
        if (result.bytes.length > this.maximumChunkBytes)
          throw new Error("RESOURCE_LIMIT: chunk");
        this.#bytes += result.bytes.length;
      } else {
        this.#closed = true;
        await this.#closeProducer();
      }
      return result;
    } finally {
      this.#pendingRead = false;
    }
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#closeProducer();
  }

  get processedBytes(): number {
    return this.#bytes;
  }

  async #closeProducer(): Promise<void> {
    if (this.#producerClosed) return;
    this.#producerClosed = true;
    await this.closeProducer();
  }
}
