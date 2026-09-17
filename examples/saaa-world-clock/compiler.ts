import binaryen from "binaryen";

import {
  canonicalJson,
  strictJsonValue,
} from "../../src/hybrid-artifact-values";
import { sha256 } from "../../src/stable-hash";

const DAY_SECONDS = 86_400;
const MAX_CITIES = 12;

export interface WorldClockCity {
  id: string;
  label: string;
  timeZone: string;
  group: string;
}

export interface WorldClockRequest {
  version: 1;
  intent: string;
  title: string;
  subtitle: string;
  accent: string;
  locale: string;
  cities: WorldClockCity[];
}

export interface WorldClockManifest {
  version: 1;
  profile: "world-clock-i32-v1";
  compiler: "l-lang-world-clock-demo@1";
  requestHash: string;
  wasmHash: string;
  wasmBytes: number;
  abi: {
    version: 1;
    exports: {
      abi_version: { params: []; result: "i32" };
      local_seconds: { params: ["i32", "i32"]; result: "i32" };
      day_delta: { params: ["i32", "i32"]; result: "i32" };
    };
    units: {
      utcSeconds: "seconds since UTC midnight";
      offsetMinutes: "IANA offset minutes supplied by host adapter";
      localSeconds: "seconds since local midnight";
      dayDelta: "-1 previous day, 0 UTC day, 1 next day";
    };
  };
  request: WorldClockRequest;
}

export interface CompiledWorldClock {
  request: WorldClockRequest;
  manifest: WorldClockManifest;
  wasm: Uint8Array;
}

export function compileWorldClock(input: unknown): CompiledWorldClock {
  const request = parseWorldClockRequest(input);
  const requestHash = sha256(canonicalJson(request));
  const wasm = emitWorldClockWasm(requestHash);
  const wasmHash = sha256(wasm);
  return {
    request,
    wasm,
    manifest: {
      version: 1,
      profile: "world-clock-i32-v1",
      compiler: "l-lang-world-clock-demo@1",
      requestHash,
      wasmHash,
      wasmBytes: wasm.byteLength,
      abi: {
        version: 1,
        exports: {
          abi_version: { params: [], result: "i32" },
          local_seconds: { params: ["i32", "i32"], result: "i32" },
          day_delta: { params: ["i32", "i32"], result: "i32" },
        },
        units: {
          utcSeconds: "seconds since UTC midnight",
          offsetMinutes: "IANA offset minutes supplied by host adapter",
          localSeconds: "seconds since local midnight",
          dayDelta: "-1 previous day, 0 UTC day, 1 next day",
        },
      },
      request,
    },
  };
}

export function parseWorldClockRequest(input: unknown): WorldClockRequest {
  const value = record(strictJsonValue(input), "request", [
    "version",
    "intent",
    "title",
    "subtitle",
    "accent",
    "locale",
    "cities",
  ]);
  if (value.version !== 1) invalid("request.version must be 1");
  const intent = text(value.intent, "request.intent", 2_000);
  const title = text(value.title, "request.title", 80);
  const subtitle = text(value.subtitle, "request.subtitle", 160);
  const accent = text(value.accent, "request.accent", 7);
  if (!/^#[0-9a-f]{6}$/i.test(accent)) {
    invalid("request.accent must be a six-digit hex color");
  }
  const locale = text(value.locale, "request.locale", 35);
  if (Intl.DateTimeFormat.supportedLocalesOf([locale]).length !== 1) {
    invalid("request.locale is not supported");
  }
  if (
    !Array.isArray(value.cities) ||
    value.cities.length === 0 ||
    value.cities.length > MAX_CITIES
  ) {
    invalid(`request.cities must contain 1-${MAX_CITIES} cities`);
  }
  const ids = new Set<string>();
  const cities = value.cities.map((item, index) => {
    const city = record(item, `request.cities[${index}]`, [
      "id",
      "label",
      "timeZone",
      "group",
    ]);
    const id = text(city.id, `request.cities[${index}].id`, 64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      invalid(`request.cities[${index}].id is invalid`);
    }
    if (ids.has(id)) invalid(`duplicate city id ${id}`);
    ids.add(id);
    const timeZone = text(
      city.timeZone,
      `request.cities[${index}].timeZone`,
      80,
    );
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format(0);
    } catch {
      invalid(`request.cities[${index}].timeZone is invalid`);
    }
    return {
      id,
      label: text(city.label, `request.cities[${index}].label`, 80),
      timeZone,
      group: text(city.group, `request.cities[${index}].group`, 40),
    };
  });
  return { version: 1, intent, title, subtitle, accent, locale, cities };
}

function emitWorldClockWasm(requestHash: string): Uint8Array {
  const module = new binaryen.Module();
  const params = binaryen.createType([binaryen.i32, binaryen.i32]);
  const sum = () =>
    module.i32.add(
      module.local.get(0, binaryen.i32),
      module.i32.mul(module.local.get(1, binaryen.i32), module.i32.const(60)),
    );
  try {
    module.setFeatures(binaryen.Features.MVP);
    module.addFunction(
      "abi_version",
      binaryen.none,
      binaryen.i32,
      [],
      module.i32.const(1),
    );
    module.addFunction(
      "local_seconds",
      params,
      binaryen.i32,
      [],
      module.i32.rem_s(
        module.i32.add(
          module.i32.rem_s(sum(), module.i32.const(DAY_SECONDS)),
          module.i32.const(DAY_SECONDS),
        ),
        module.i32.const(DAY_SECONDS),
      ),
    );
    module.addFunction(
      "day_delta",
      params,
      binaryen.i32,
      [],
      module.if(
        module.i32.lt_s(sum(), module.i32.const(0)),
        module.i32.const(-1),
        module.if(
          module.i32.ge_s(sum(), module.i32.const(DAY_SECONDS)),
          module.i32.const(1),
          module.i32.const(0),
        ),
      ),
    );
    for (const name of ["abi_version", "local_seconds", "day_delta"]) {
      module.addFunctionExport(name, name);
    }
    module.addCustomSection(
      "llang.world-clock",
      new TextEncoder().encode(requestHash),
    );
    if (
      module.hasMemory() ||
      module.getNumTables() > 0 ||
      module.getNumGlobals() > 0 ||
      module.getStart() !== 0
    ) {
      throw new Error("world clock Wasm must be stateless");
    }
    if (!module.validate()) throw new Error("Binaryen validation failed");
    const wasm = new Uint8Array(module.emitBinary());
    if (!WebAssembly.validate(wasm)) throw new Error("Wasm validation failed");
    return wasm;
  } finally {
    module.dispose();
  }
}

function record(
  input: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalid(`${path} must be an object`);
  }
  const result = input as Record<string, unknown>;
  const keys = Object.keys(result);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key))
  ) {
    invalid(`${path} must contain exactly ${allowed.join(", ")}`);
  }
  return result;
}

function text(input: unknown, path: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum
  ) {
    invalid(
      `${path} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return input;
}

function invalid(message: string): never {
  throw new Error(`INVALID_WORLD_CLOCK_REQUEST: ${message}`);
}
