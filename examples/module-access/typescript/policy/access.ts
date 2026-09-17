// @ts-nocheck -- explicit extensions are part of the L-Lang module profile.
import type { User } from "../domain/user.ts";
import { isEnabled } from "../domain/user.ts";
function both(left: boolean, right: boolean): boolean {
  return left && right;
}
export function isAllowed(user: User): boolean {
  return both(isEnabled(user), !user.suspended);
}
