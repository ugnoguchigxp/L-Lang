import { readFile, writeFile } from "node:fs/promises";

export type ValueMemorySafetyMatrix = {
  format: "llang-value-memory-safety-matrix";
  version: 1;
  profile: string;
  abi: string;
  entries: {
    id: string;
    subject: string;
    guaranteedBy: string;
    condition: string;
    positive: string[];
    negative: string[];
    limitation: string;
  }[];
};

const escapeCell = (value: string) => value.replaceAll("|", "\\|");

export function renderValueMemorySafetyMatrix(
  matrix: ValueMemorySafetyMatrix,
): string {
  const rows = matrix.entries.map(
    (entry) =>
      `| ${escapeCell(entry.id)} | ${escapeCell(entry.subject)} | ${escapeCell(entry.guaranteedBy)} | ${escapeCell(entry.condition)} | ${escapeCell(entry.positive.join("; "))} | ${escapeCell(entry.negative.join("; "))} | ${escapeCell(entry.limitation)} |`,
  );
  return `# Value Wasm Memory Safety Matrix

対象profileは\`${matrix.profile}\`、ABIは\`${matrix.abi}\`である。この文書は[Memory Safety Matrix JSON](../benchmarks/value-memory-v1/memory-safety-matrix.json)から生成する。schemaは[value-memory-safety-matrix-v1](../schemas/value-memory-safety-matrix-v1.schema.json)に置く。

| ID | Subject | Guaranteed by | Condition | Positive vectors | Negative vectors | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

generated Wasmは、top-level rangeを確認してから型別rootを読み、string payloadの包含を確認してからUTF-8を走査する。不正なdirect ABI入力はstatus 1 \`INVALID_INPUT\`で返す。arithmetic、division、resource、internal artifact faultは既存status 2〜5を維持する。

public runtimeは呼出しごとにfresh instanceを生成する。direct ABIでは同期評価中にhostがmemoryを変更しないことを前提とし、安全なimmutable payload alias、unaligned access、非zero input paddingの既存受理範囲を維持する。
`;
}

async function main(): Promise<void> {
  const input = process.argv[2],
    output = process.argv[3];
  if (!input || !output || process.argv.length !== 4)
    throw new Error(
      "usage: llang-value-memory-matrix <input.json> <output.md>",
    );
  const matrix = JSON.parse(
    await readFile(input, "utf8"),
  ) as ValueMemorySafetyMatrix;
  await writeFile(output, renderValueMemorySafetyMatrix(matrix));
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
