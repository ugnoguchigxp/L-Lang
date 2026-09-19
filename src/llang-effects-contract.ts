import { fingerprintFor } from "./stable-hash";

export type EffectKind = "file" | "http" | "clock" | "host";
export type OperationDefinition = Readonly<{
  id: string;
  version: number;
  requestType: unknown;
  responseType: unknown;
  errorType: unknown;
  effect: EffectKind;
  resource: "none" | "file" | "http-body" | "stream";
  cancellable: boolean;
  idempotent: boolean;
}>;
export type OperationRequirement = Readonly<{
  id: string;
  version: number;
  signatureHash: string;
  effect: EffectKind;
}>;
export type EffectsManifest = Readonly<{
  profile: "module-effects-v1";
  abi: "llang-effects-session-v1";
  operations: readonly OperationRequirement[];
  effects: readonly EffectKind[];
}>;

const ID = /^[a-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const effectOrder: EffectKind[] = ["clock", "file", "host", "http"];

export function operationSignature(definition: OperationDefinition): string {
  return fingerprintFor({
    id: definition.id,
    version: definition.version,
    requestType: definition.requestType,
    responseType: definition.responseType,
    errorType: definition.errorType,
    effect: definition.effect,
    resource: definition.resource,
    cancellable: definition.cancellable,
    idempotent: definition.idempotent,
  });
}

export class HostOperationRegistry {
  readonly #operations = new Map<string, OperationDefinition>();

  constructor(definitions: readonly OperationDefinition[]) {
    for (const definition of definitions) {
      if (
        !ID.test(definition.id) ||
        !Number.isInteger(definition.version) ||
        definition.version < 1
      )
        throw new Error("INVALID_OPERATION_DEFINITION");
      const key = `${definition.id}@${definition.version}`;
      if (this.#operations.has(key)) throw new Error("DUPLICATE_OPERATION");
      this.#operations.set(key, Object.freeze({ ...definition }));
    }
  }

  get(id: string, version: number): OperationDefinition | undefined {
    return this.#operations.get(`${id}@${version}`);
  }

  requirement(id: string, version: number): OperationRequirement {
    const operation = this.get(id, version);
    if (!operation) throw new Error("UNKNOWN_OPERATION");
    return Object.freeze({
      id,
      version,
      signatureHash: operationSignature(operation),
      effect: operation.effect,
    });
  }

  verify(manifest: EffectsManifest): void {
    const declaredEffects = new Set(manifest.effects);
    if (
      manifest.profile !== "module-effects-v1" ||
      manifest.abi !== "llang-effects-session-v1" ||
      manifest.effects.length !== declaredEffects.size ||
      [...declaredEffects].some((effect) => !effectOrder.includes(effect)) ||
      [...manifest.effects].join() !==
        [...manifest.effects]
          .sort((a, b) => effectOrder.indexOf(a) - effectOrder.indexOf(b))
          .join()
    )
      throw new Error("INVALID_EFFECTS_MANIFEST");
    const seen = new Set<string>();
    for (const requirement of manifest.operations) {
      const key = `${requirement.id}@${requirement.version}`,
        operation = this.get(requirement.id, requirement.version);
      if (
        seen.has(key) ||
        !operation ||
        !HASH.test(requirement.signatureHash) ||
        operationSignature(operation) !== requirement.signatureHash ||
        operation.effect !== requirement.effect ||
        !declaredEffects.has(requirement.effect)
      )
        throw new Error("OPERATION_CONTRACT_MISMATCH");
      seen.add(key);
    }
  }
}

export function effectsManifest(
  registry: HostOperationRegistry,
  operations: readonly { id: string; version: number }[],
): EffectsManifest {
  const unique = new Map(
      operations.map((operation) => [
        `${operation.id}@${operation.version}`,
        operation,
      ]),
    ),
    requirements = [...unique.values()]
      .map(({ id, version }) => registry.requirement(id, version))
      .sort((a, b) =>
        a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id),
      ),
    effects = [...new Set(requirements.map((item) => item.effect))].sort(
      (a, b) => effectOrder.indexOf(a) - effectOrder.indexOf(b),
    );
  return Object.freeze({
    profile: "module-effects-v1",
    abi: "llang-effects-session-v1",
    operations: Object.freeze(requirements),
    effects: Object.freeze(effects),
  });
}

export type EffectsGrant = Readonly<{
  operations: ReadonlySet<string>;
  file?: Readonly<{
    roots: readonly string[];
    read: boolean;
    write: boolean;
    replace: boolean;
  }>;
  http?: Readonly<{
    origins: ReadonlySet<string>;
    methods: ReadonlySet<string>;
    requestHeaders: ReadonlySet<string>;
  }>;
  wallClock: boolean;
}>;

export function assertGranted(
  operation: OperationDefinition,
  grant: EffectsGrant,
  target?: Readonly<{
    path?: string;
    fileMode?: "read" | "write" | "replace";
    url?: string;
    method?: string;
    headers?: readonly string[];
  }>,
): void {
  if (!grant.operations.has(`${operation.id}@${operation.version}`))
    throw new Error("PERMISSION_DENIED: operation");
  if (operation.effect === "file") {
    if (!grant.file || !target?.path || !target.fileMode)
      throw new Error("PERMISSION_DENIED: file");
    const targetPath = target.path,
      parts = targetPath.split("/");
    if (targetPath.startsWith("/")) parts.shift();
    if (
      !targetPath ||
      targetPath.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("PERMISSION_DENIED: file");
    const allowed = grant.file.roots.some((root) => {
      const prefix = root.endsWith("/") ? root : `${root}/`;
      return targetPath === root || targetPath.startsWith(prefix);
    });
    if (
      !allowed ||
      (target.fileMode === "read" && !grant.file.read) ||
      (target.fileMode === "write" && !grant.file.write) ||
      (target.fileMode === "replace" &&
        (!grant.file.write || !grant.file.replace))
    )
      throw new Error("PERMISSION_DENIED: file");
  }
  if (operation.effect === "http") {
    if (!grant.http || !target?.url || !target.method)
      throw new Error("PERMISSION_DENIED: http");
    let origin: string;
    try {
      const url = new URL(target.url);
      if (
        url.username ||
        url.password ||
        !["http:", "https:"].includes(url.protocol)
      )
        throw new Error();
      origin = url.origin;
    } catch {
      throw new Error("PERMISSION_DENIED: http");
    }
    if (
      !grant.http.origins.has(origin) ||
      !grant.http.methods.has(target.method.toUpperCase()) ||
      (target.headers ?? []).some(
        (header) => !grant.http?.requestHeaders.has(header.toLowerCase()),
      )
    )
      throw new Error("PERMISSION_DENIED: http");
  }
  if (operation.id === "clock.wall" && !grant.wallClock)
    throw new Error("PERMISSION_DENIED: wall clock");
}

export type BudgetLimits = Readonly<{
  hostRequests: number;
  tasks: number;
  concurrentIo: number;
  concurrentTasks: number;
  openResources: number;
  streams: number;
  sentBytes: number;
  receivedBytes: number;
  memoryBytes: number;
  fuel: number;
}>;

export const DEFAULT_EFFECTS_LIMITS: BudgetLimits = Object.freeze({
  hostRequests: 1024,
  tasks: 1024,
  concurrentIo: 8,
  concurrentTasks: 8,
  openResources: 32,
  streams: 32,
  sentBytes: 64 * 1024 * 1024,
  receivedBytes: 64 * 1024 * 1024,
  memoryBytes: 32 * 1024 * 1024,
  fuel: 10_000_000,
});

export class ResourceLedger {
  readonly #used = new Map<keyof BudgetLimits, number>();
  readonly #peak = new Map<keyof BudgetLimits, number>();

  constructor(readonly limits: BudgetLimits = DEFAULT_EFFECTS_LIMITS) {
    for (const [name, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`INVALID_LIMIT: ${name}`);
  }

  consume(name: keyof BudgetLimits, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Error("INVALID_BUDGET_AMOUNT");
    const next = (this.#used.get(name) ?? 0) + amount;
    if (next > this.limits[name]) throw new Error(`RESOURCE_LIMIT: ${name}`);
    this.#used.set(name, next);
    this.#peak.set(name, Math.max(this.#peak.get(name) ?? 0, next));
  }

  release(
    name: "concurrentIo" | "concurrentTasks" | "openResources" | "streams",
    amount = 1,
  ): void {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Error("INVALID_BUDGET_AMOUNT");
    const next = (this.#used.get(name) ?? 0) - amount;
    if (next < 0) throw new Error(`INVALID_RELEASE: ${name}`);
    this.#used.set(name, next);
  }

  used(name: keyof BudgetLimits): number {
    return this.#used.get(name) ?? 0;
  }

  snapshot(): Readonly<{
    limits: BudgetLimits;
    used: BudgetLimits;
    peak: BudgetLimits;
  }> {
    const values = (source: ReadonlyMap<keyof BudgetLimits, number>) =>
      Object.freeze(
        Object.fromEntries(
          Object.keys(this.limits).map((name) => [
            name,
            source.get(name as keyof BudgetLimits) ?? 0,
          ]),
        ) as BudgetLimits,
      );
    return Object.freeze({
      limits: this.limits,
      used: values(this.#used),
      peak: values(this.#peak),
    });
  }
}

export type EffectFunction = Readonly<{
  name: string;
  declared: readonly EffectKind[];
  operations: readonly { id: string; version: number }[];
  calls: readonly string[];
  callbackLimit?: readonly EffectKind[];
}>;

export function checkTransitiveEffects(
  functions: readonly EffectFunction[],
  registry: HostOperationRegistry,
): ReadonlyMap<string, readonly EffectKind[]> {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  if (byName.size !== functions.length) throw new Error("DUPLICATE_FUNCTION");
  const memo = new Map<string, Set<EffectKind>>();
  for (const fn of functions) {
    const effects = new Set<EffectKind>();
    for (const requirement of fn.operations) {
      const operation = registry.get(requirement.id, requirement.version);
      if (!operation) throw new Error("UNKNOWN_OPERATION");
      effects.add(operation.effect);
    }
    for (const callee of fn.calls)
      if (!byName.has(callee)) throw new Error(`UNKNOWN_FUNCTION: ${callee}`);
    memo.set(fn.name, effects);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      const effects = memo.get(fn.name);
      if (!effects) throw new Error(`UNKNOWN_FUNCTION: ${fn.name}`);
      for (const callee of fn.calls)
        for (const effect of memo.get(callee) ?? [])
          if (!effects.has(effect)) {
            effects.add(effect);
            changed = true;
          }
    }
  }
  for (const fn of functions) {
    const effects = memo.get(fn.name);
    if (!effects) throw new Error(`UNKNOWN_FUNCTION: ${fn.name}`);
    const declared = new Set(fn.declared);
    if ([...effects].some((effect) => !declared.has(effect)))
      throw new Error(`EFFECT_DECLARATION_EXCEEDED: ${fn.name}`);
    if (
      fn.callbackLimit &&
      [...effects].some((effect) => !fn.callbackLimit?.includes(effect))
    )
      throw new Error(`CALLBACK_EFFECT_EXCEEDED: ${fn.name}`);
  }
  return new Map(
    [...memo].map(([name, effects]) => [
      name,
      Object.freeze(
        [...effects].sort(
          (a, b) => effectOrder.indexOf(a) - effectOrder.indexOf(b),
        ),
      ),
    ]),
  );
}
