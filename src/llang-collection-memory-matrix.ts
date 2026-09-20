import { readFile, writeFile } from "node:fs/promises";

export type CollectionMemorySafetyMatrix = {
  format: "llang-collection-memory-safety-matrix";
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

export function renderCollectionMemorySafetyMatrix(
  matrix: CollectionMemorySafetyMatrix,
): string {
  const rows = matrix.entries.map(
    (entry) =>
      `| ${escapeCell(entry.id)} | ${escapeCell(entry.subject)} | ${escapeCell(entry.guaranteedBy)} | ${escapeCell(entry.condition)} | ${escapeCell(entry.positive.join("; "))} | ${escapeCell(entry.negative.join("; "))} | ${escapeCell(entry.limitation)} |`,
  );
  return `# Collection Memory Safety Matrix

対象profileは\`${matrix.profile}\`、ABIは\`${matrix.abi}\`である。この文書は[Memory Safety Matrix JSON](../benchmarks/collection-memory-v1/memory-safety-matrix.json)から生成する。schemaは[collection-memory-safety-matrix-v1](../schemas/collection-memory-safety-matrix-v1.schema.json)に置く。

| ID | Subject | Guaranteed by | Condition | Positive vectors | Negative vectors | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

generated Wasmは検査失敗をfault code 5 \`INVALID_ARTIFACT\`でtrapする。実行中のindex、division、arithmetic、resource faultは既存code 1〜4を維持する。Wasm trap後は同じinstanceを再利用せず、新しいinstanceで次の評価を行う。

validatorのclaim bitmapはinput/outputと重ならないmodule-private領域を呼出しごとに選ぶ。bitmapはinput wire長により有界であり、検査完了後に参照されない。ABI利用者が所有できる領域は明示したinput/outputだけである。
`;
}

async function main(): Promise<void> {
  const input = process.argv[2],
    output = process.argv[3];
  if (!input || !output || process.argv.length !== 4)
    throw new Error(
      "usage: llang-collection-memory-matrix <input.json> <output.md>",
    );
  const matrix = JSON.parse(
    await readFile(input, "utf8"),
  ) as CollectionMemorySafetyMatrix;
  await writeFile(output, renderCollectionMemorySafetyMatrix(matrix));
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
