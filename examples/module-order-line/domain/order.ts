// @ts-nocheck -- explicit extensions are part of the L-Lang module profile.
export type OrderLine = {
  member: boolean;
  productCode: string;
  quantity: number;
  unitPrice: number;
};

export type QuoteResult =
  | { tag: "ok"; label: string; total: number }
  | { tag: "error"; code: string };
