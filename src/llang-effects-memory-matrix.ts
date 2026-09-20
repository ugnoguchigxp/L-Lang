import { readFile, writeFile } from "node:fs/promises";

export type EffectsMemorySafetyMatrix = {
  format: "llang-effects-memory-safety-matrix";
  version: 1;
  profile: string;
  abi: string;
  entries: {
    id: string;
    subject: string;
    guaranteedBy: string;
    positive: string[];
    negative: string[];
    limitation: string;
  }[];
};

const escapeCell = (value: string) => value.replaceAll("|", "\\|");

export function renderEffectsMemorySafetyMatrix(
  matrix: EffectsMemorySafetyMatrix,
): string {
  const rows = matrix.entries.map(
    (entry) =>
      `| ${escapeCell(entry.id)} | ${escapeCell(entry.subject)} | ${escapeCell(entry.guaranteedBy)} | ${escapeCell(entry.positive.join("; "))} | ${escapeCell(entry.negative.join("; "))} | ${escapeCell(entry.limitation)} |`,
  );
  return `# Effects Wasm Memory Safety Matrix

対象profileは\`${matrix.profile}\`、ABIは\`${matrix.abi}\`である。この文書は[Memory Safety Matrix JSON](../benchmarks/effects-memory-v1/memory-safety-matrix.json)から生成する。schemaは[effects-memory-safety-matrix-v1](../schemas/effects-memory-safety-matrix-v1.schema.json)に置く。

| ID | Subject | Guaranteed by | Positive vectors | Negative vectors | Limitation |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

linear／typed continuation Wasmは、event descriptorを包含確認後に一度だけ読み、成功responseのoutput、typed payload、module-private領域をstate更新前に検査する。retryable boundary faultはstatus 4 \`FAILED\`で返り、fault 5または8へ分類される。

exported memoryを直接変更できるhost、typed payloadの意味、外部adapterと副作用の正当性はこの境界の保証対象ではない。
`;
}

async function main(): Promise<void> {
  const input = process.argv[2],
    output = process.argv[3];
  if (!input || !output || process.argv.length !== 4)
    throw new Error(
      "usage: llang-effects-memory-matrix <input.json> <output.md>",
    );
  const matrix = JSON.parse(
    await readFile(input, "utf8"),
  ) as EffectsMemorySafetyMatrix;
  await writeFile(output, renderEffectsMemorySafetyMatrix(matrix));
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
