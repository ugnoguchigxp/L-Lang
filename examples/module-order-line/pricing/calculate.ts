// @ts-nocheck -- explicit extensions are part of the L-Lang module profile.
import type { OrderLine } from "../domain/order.ts";

export function calculate(line: OrderLine): number {
  return line.unitPrice * line.quantity;
}
