export interface PremiumAccessInput {
  accountActive: boolean;
  role: "viewer" | "editor" | "admin";
  maintenanceOverride: boolean;
  suspended: boolean;
}

export function canAccessPremium(input: PremiumAccessInput): boolean {
  return (
    input.accountActive === true &&
    (input.role === "admin" || input.maintenanceOverride === true) &&
    !(input.suspended === true)
  );
}
