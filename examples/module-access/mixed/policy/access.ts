// @ts-nocheck -- JSONC signatures are supplied by the L-Lang module frontend.
import type { User } from "../domain/user.llang.jsonc";
import { isEnabled } from "../domain/user.llang.jsonc";
function both(left: boolean, right: boolean): boolean {
  return left && right;
}
export function isAllowed(user: User): boolean {
  return both(isEnabled(user), !user.suspended);
}
