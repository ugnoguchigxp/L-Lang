import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildModuleProgram } from "./llang-module-build";
import { testModuleProgram, verifyModuleBundle } from "./llang-module-suite";
import { buildValueModuleProgram } from "./llang-module-value-build";
import {
  testValueModuleProgram,
  verifyValueModuleBundle,
} from "./llang-module-value-suite";
import { buildCollectionModuleProgram } from "./llang-module-collection-build";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import {
  testCollectionModuleProgram,
  verifyCollectionModuleBundle,
} from "./llang-module-collection-suite";

const configurations = [
  { name: "jsonc", entry: "application/main.llang.jsonc" },
  { name: "typescript", entry: "application/main.ts" },
  { name: "mixed", entry: "application/main.llang.jsonc" },
] as const;
const suite = "examples/module-access/cases.json";
const hashes = new Set<string>();
for (const configuration of configurations) {
  const root = `examples/module-access/${configuration.name}`;
  const report = await testModuleProgram({
    entry: configuration.entry,
    root,
    entryName: "canAccess",
    suite,
  });
  if (!report.ok)
    throw new Error(`${configuration.name} reference test failed`);
  hashes.add(report.programHash);
}
if (hashes.size !== 1) throw new Error("frontend program hashes differ");
const temporary = await mkdtemp(join(tmpdir(), "llang-module-smoke-"));
try {
  const out = join(temporary, "bundle");
  await buildModuleProgram({
    entry: "application/main.llang.jsonc",
    root: "examples/module-access/mixed",
    entryName: "canAccess",
    target: "all",
    outDir: out,
  });
  const portable = await verifyModuleBundle(
    join(out, "module-build.json"),
    suite,
  );
  if (!portable.ok) throw new Error("portable Wasm verification failed");
  const valueRoot = join(temporary, "value-sources");
  const sourceRoot = "examples/module-order-line";
  const valueConfigurations = [
    {
      name: "jsonc",
      entry: "application/quote.llang.jsonc",
      app: "jsonc",
      pricing: "jsonc",
      domain: "jsonc",
    },
    {
      name: "typescript",
      entry: "application/quote.ts",
      app: "ts",
      pricing: "ts",
      domain: "ts",
    },
    {
      name: "jsonc-ts-jsonc",
      entry: "application/quote.llang.jsonc",
      app: "jsonc",
      pricing: "ts",
      domain: "jsonc",
    },
    {
      name: "ts-jsonc-ts",
      entry: "application/quote.ts",
      app: "ts",
      pricing: "jsonc",
      domain: "ts",
    },
  ] as const;
  const valueHashes = new Set<string>();
  for (const configuration of valueConfigurations) {
    const root = join(valueRoot, configuration.name);
    await Promise.all(
      ["application", "pricing", "domain"].map((part) =>
        mkdir(join(root, part), { recursive: true }),
      ),
    );
    const appName =
        configuration.app === "ts" ? "quote.ts" : "quote.llang.jsonc",
      pricingName =
        configuration.pricing === "ts"
          ? "calculate.ts"
          : "calculate.llang.jsonc",
      domainName =
        configuration.domain === "ts" ? "order.ts" : "order.llang.jsonc";
    let app = await readFile(join(sourceRoot, "application", appName), "utf8"),
      pricing = await readFile(
        join(sourceRoot, "pricing", pricingName),
        "utf8",
      ),
      domain = await readFile(join(sourceRoot, "domain", domainName), "utf8");
    app = app
      .replace(/calculate(?:\.llang\.jsonc|\.ts)/g, pricingName)
      .replace(/order(?:\.llang\.jsonc|\.ts)/g, domainName);
    pricing = pricing.replace(/order(?:\.llang\.jsonc|\.ts)/g, domainName);
    await Promise.all([
      writeFile(join(root, "application", appName), app),
      writeFile(join(root, "pricing", pricingName), pricing),
      writeFile(join(root, "domain", domainName), domain),
    ]);
    const report = await testValueModuleProgram({
      entry: configuration.entry,
      root,
      entryName: "quote",
      suite: "examples/module-order-line/suite.json",
    });
    if (!report.ok) throw new Error(`${configuration.name} value test failed`);
    valueHashes.add(report.programHash);
  }
  if (valueHashes.size !== 1)
    throw new Error("value frontend program hashes differ");
  const valueOut = join(temporary, "value-bundle");
  await buildValueModuleProgram({
    entry: "application/quote.ts",
    root: join(valueRoot, "typescript"),
    entryName: "quote",
    target: "all",
    outDir: valueOut,
  });
  const valuePortable = await verifyValueModuleBundle(
    join(valueOut, "module-build.json"),
    "examples/module-order-line/suite.json",
  );
  if (!valuePortable.ok)
    throw new Error("portable value Wasm verification failed");
  const collectionRoot = join(temporary, "collection-sources"),
    collectionSource = "examples/module-order-batch",
    collectionConfigurations = [
      { name: "jsonc", app: "jsonc", domain: "jsonc" },
      { name: "typescript", app: "ts", domain: "ts" },
      { name: "jsonc-ts", app: "jsonc", domain: "ts" },
      { name: "ts-jsonc", app: "ts", domain: "jsonc" },
    ] as const,
    collectionHashes = new Set<string>();
  for (const configuration of collectionConfigurations) {
    const root = join(collectionRoot, configuration.name);
    await Promise.all(
      ["application", "domain"].map((part) =>
        mkdir(join(root, part), { recursive: true }),
      ),
    );
    const appName =
        configuration.app === "ts" ? "evaluate.ts" : "evaluate.llang.jsonc",
      domainName =
        configuration.domain === "ts" ? "order.ts" : "order.llang.jsonc";
    let app = await readFile(
      join(collectionSource, "application", appName),
      "utf8",
    );
    app = app.replace(/order(?:\.llang\.jsonc|\.ts)/g, domainName);
    await Promise.all([
      writeFile(join(root, "application", appName), app),
      writeFile(
        join(root, "domain", domainName),
        await readFile(join(collectionSource, "domain", domainName), "utf8"),
      ),
    ]);
    const report = await testCollectionModuleProgram({
      entry: `application/${appName}`,
      root,
      entryName: "evaluate",
      suite: "examples/module-order-batch/suite.json",
    });
    if (!report.ok)
      throw new Error(`${configuration.name} collection test failed`);
    const checked = await loadCollectionModuleProgram(
      `application/${appName}`,
      root,
      "evaluate",
    );
    collectionHashes.add(checked.programHash);
  }
  if (collectionHashes.size !== 1)
    throw new Error("collection frontend program hashes differ");
  const collectionOut = join(temporary, "collection-bundle");
  await buildCollectionModuleProgram({
    entry: "application/evaluate.ts",
    root: join(collectionRoot, "typescript"),
    entryName: "evaluate",
    target: "all",
    outDir: collectionOut,
  });
  const collectionPortable = await verifyCollectionModuleBundle(
    join(collectionOut, "module-build.json"),
    "examples/module-order-batch/suite.json",
  );
  if (!collectionPortable.ok)
    throw new Error("portable collection verification failed");
  console.log(
    JSON.stringify({
      ok: true,
      configurations: configurations.length,
      programHash: [...hashes][0],
      portableCases: portable.results.length,
      valueConfigurations: valueConfigurations.length,
      valueProgramHash: [...valueHashes][0],
      valuePortableCases: valuePortable.results.length,
      collectionConfigurations: collectionConfigurations.length,
      collectionProgramHash: [...collectionHashes][0],
      collectionPortableCases: collectionPortable.cases.length,
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
