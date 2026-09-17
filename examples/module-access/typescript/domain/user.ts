// @ts-nocheck -- this file is compiled by the closed L-Lang module frontend.
export type User = { enabled: boolean; suspended: boolean };
export function isEnabled(user: User): boolean {
  return user.enabled;
}
