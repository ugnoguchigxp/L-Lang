export interface FeatureInput {
  enabled: boolean;
}

export function isFeatureEnabled(input: FeatureInput): boolean {
  return input.enabled === true;
}
