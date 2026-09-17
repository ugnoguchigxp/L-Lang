export interface AccountInput {
  blocked?: boolean | undefined;
}

export function isNotBlocked(input: AccountInput): boolean {
  return input.blocked !== true;
}
