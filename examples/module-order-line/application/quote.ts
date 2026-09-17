// @ts-nocheck -- explicit extensions are part of the L-Lang module profile.
import type { OrderLine, QuoteResult } from "../domain/order.ts";
import { calculate } from "../pricing/calculate.ts";

export function quote(line: OrderLine): QuoteResult {
  if (line.quantity > 0) {
    return { tag: "ok", total: calculate(line), label: line.productCode };
  } else {
    return { tag: "error", code: "INVALID_QUANTITY" };
  }
}
