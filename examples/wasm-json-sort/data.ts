export const keys = ["name", "age", "race"] as const;
export type SortKey = (typeof keys)[number];
export interface Character {
  id: number;
  name: string;
  age: number;
  race: string;
  region: string;
  bio: string;
}
export const MAX_RECORDS = 20000;

export function generateJson(
  targetBytes = 100 * 1024,
  targetRecords?: number,
): string {
  if (
    targetRecords !== undefined &&
    (!Number.isInteger(targetRecords) ||
      targetRecords < 1 ||
      targetRecords > MAX_RECORDS)
  )
    throw new Error(`Target records must be in 1..${MAX_RECORDS}`);
  if (
    !Number.isInteger(targetBytes) ||
    targetBytes < 2 ||
    targetBytes > 3000000
  ) {
    throw new Error("Target bytes must be an integer in 2..3000000");
  }
  const rows: Character[] = [];
  let size = 3; // [\n ... ]\n
  let seed = 20260917;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const names = [
    "Aster",
    "Beryl",
    "Cedar",
    "Dawn",
    "Ember",
    "Faye",
    "光",
    "葵",
    "Émile",
    "😀",
  ];
  const races = ["human", "elf", "dwarf", "orc", "halfling"];
  do {
    const row: Character = {
      id: rows.length,
      name: `${names[random() % names.length]} ${random() % 80}`,
      age: random() % 121,
      race: races[random() % races.length] ?? "human",
      region: ["north", "south", "east", "west"][random() % 4] ?? "north",
      bio: "Synthetic fantasy character for a reproducible sorting experiment.",
    };
    rows.push(row);
    size +=
      Buffer.byteLength(JSON.stringify(row)) + (rows.length === 1 ? 1 : 2);
    if (rows.length > MAX_RECORDS)
      throw new Error(`Maximum ${MAX_RECORDS} records`);
  } while (
    targetRecords === undefined
      ? size < targetBytes
      : rows.length < targetRecords
  );
  return `[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
}

export function parseRows(json: string): Character[] {
  const rows: unknown = JSON.parse(json);
  if (!Array.isArray(rows) || rows.length > MAX_RECORDS) {
    throw new Error(`Expected an array with at most ${MAX_RECORDS} records`);
  }
  const ids = new Set<number>();
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !Number.isSafeInteger(row.id) ||
      ids.has(row.id) ||
      typeof row.name !== "string" ||
      typeof row.race !== "string" ||
      typeof row.region !== "string" ||
      typeof row.bio !== "string" ||
      !Number.isSafeInteger(row.age) ||
      row.age < 0
    )
      throw new Error("Invalid character record or duplicate id");
    ids.add(row.id);
  }
  return rows as Character[];
}

export function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Rank strings on the host; preserve input order for ties using the row index.
// n <= 20,000 means rank*n+index <= 399,999,999, safely inside signed i32.
export function encode(rows: Character[], key: SortKey): Int32Array {
  if (rows.length > MAX_RECORDS) throw new Error("Too many records");
  const values = [...new Set(rows.map((row) => row[key]))].sort(compare);
  const ranks = new Map(values.map((value, rank) => [value, rank]));
  return Int32Array.from(rows, (row, index) => {
    const rank = ranks.get(row[key]);
    if (rank === undefined) throw new Error("Missing rank");
    return rank * rows.length + index;
  });
}

export function decode(rows: Character[], encoded: Int32Array): Character[] {
  return Array.from(encoded, (value) => {
    const row = rows[value % rows.length];
    if (!row) throw new Error("Invalid sorted row index");
    return row;
  });
}

export function reference(rows: Character[], key: SortKey): Character[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compare(a.row[key], b.row[key]) || a.index - b.index)
    .map(({ row }) => row);
}
