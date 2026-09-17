// @ts-nocheck -- explicit extensions are part of the L-Lang module profile.
import type { User } from "../domain/user.ts";
import { isAllowed } from "../policy/access.ts";
export function canAccess(user: User): boolean {
  return isAllowed(user);
}
