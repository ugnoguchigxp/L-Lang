export type User = { enabled: boolean; suspended: boolean };

export function evaluate(user: User): boolean {
  return user.enabled === true;
}
