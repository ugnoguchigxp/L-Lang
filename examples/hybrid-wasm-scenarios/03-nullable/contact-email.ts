export interface ContactInput {
  email?: string | null | undefined;
}

export function hasContactEmail(input: ContactInput): boolean {
  return input.email !== null && input.email !== undefined;
}
