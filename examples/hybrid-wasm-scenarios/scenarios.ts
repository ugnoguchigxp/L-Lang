export interface HybridWasmScenarioCase {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
}

export interface HybridWasmScenario {
  id: string;
  level: number;
  title: string;
  demonstrates: string;
  source: string;
  functionName: string;
  cases: HybridWasmScenarioCase[];
}

export const HYBRID_WASM_SCENARIOS: HybridWasmScenario[] = [
  {
    id: "01-boolean",
    level: 1,
    title: "Boolean flag",
    demonstrates: "required boolean and strict equality",
    source: "examples/hybrid-wasm-scenarios/01-boolean/feature-enabled.ts",
    functionName: "isFeatureEnabled",
    cases: [
      { name: "enabled", input: { enabled: true }, expected: true },
      { name: "disabled", input: { enabled: false }, expected: false },
    ],
  },
  {
    id: "02-enum",
    level: 2,
    title: "Closed enum",
    demonstrates: "closed string union and OR",
    source: "examples/hybrid-wasm-scenarios/02-enum/payment-actionable.ts",
    functionName: "isPaymentActionable",
    cases: [
      { name: "pending", input: { status: "pending" }, expected: false },
      { name: "authorized", input: { status: "authorized" }, expected: true },
      { name: "paid", input: { status: "paid" }, expected: true },
      { name: "failed", input: { status: "failed" }, expected: false },
    ],
  },
  {
    id: "03-nullable",
    level: 3,
    title: "Nullable presence",
    demonstrates: "missing, undefined, null, and present string states",
    source: "examples/hybrid-wasm-scenarios/03-nullable/contact-email.ts",
    functionName: "hasContactEmail",
    cases: [
      { name: "missing", input: {}, expected: false },
      { name: "undefined", input: { email: undefined }, expected: false },
      { name: "null", input: { email: null }, expected: false },
      { name: "empty-but-present", input: { email: "" }, expected: true },
      {
        name: "address-present",
        input: { email: "user@example.com" },
        expected: true,
      },
    ],
  },
  {
    id: "04-safe-default",
    level: 4,
    title: "Optional boolean safe default",
    demonstrates: "strict inequality and optional boolean semantics",
    source: "examples/hybrid-wasm-scenarios/04-safe-default/not-blocked.ts",
    functionName: "isNotBlocked",
    cases: [
      { name: "missing", input: {}, expected: true },
      { name: "undefined", input: { blocked: undefined }, expected: true },
      { name: "explicit-false", input: { blocked: false }, expected: true },
      { name: "blocked", input: { blocked: true }, expected: false },
    ],
  },
  {
    id: "05-composite",
    level: 5,
    title: "Composite access rule",
    demonstrates: "nested AND, OR, and NOT over booleans and enum",
    source: "examples/hybrid-wasm-scenarios/05-composite/access-premium.ts",
    functionName: "canAccessPremium",
    cases: [
      {
        name: "active-admin",
        input: {
          accountActive: true,
          role: "admin",
          maintenanceOverride: false,
          suspended: false,
        },
        expected: true,
      },
      {
        name: "maintenance-override",
        input: {
          accountActive: true,
          role: "viewer",
          maintenanceOverride: true,
          suspended: false,
        },
        expected: true,
      },
      {
        name: "suspended-admin",
        input: {
          accountActive: true,
          role: "admin",
          maintenanceOverride: false,
          suspended: true,
        },
        expected: false,
      },
      {
        name: "inactive-admin",
        input: {
          accountActive: false,
          role: "admin",
          maintenanceOverride: true,
          suspended: false,
        },
        expected: false,
      },
    ],
  },
  {
    id: "06-business-rule",
    level: 6,
    title: "Shipping business rule",
    demonstrates: "realistic enum, boolean, nullable, and optional composition",
    source: "examples/hybrid-wasm-scenarios/06-business-rule/can-ship-order.ts",
    functionName: "canShipOrder",
    cases: [
      {
        name: "paid-and-ready",
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: null,
          cancelled: false,
        },
        expected: true,
      },
      {
        name: "authorized-and-ready-with-optionals-missing",
        input: { paymentStatus: "authorized", inventoryReserved: true },
        expected: true,
      },
      {
        name: "payment-pending",
        input: {
          paymentStatus: "pending",
          inventoryReserved: true,
          holdReason: null,
        },
        expected: false,
      },
      {
        name: "inventory-missing",
        input: {
          paymentStatus: "paid",
          inventoryReserved: false,
          holdReason: null,
        },
        expected: false,
      },
      {
        name: "fraud-hold",
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: "fraud",
        },
        expected: false,
      },
      {
        name: "cancelled",
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: undefined,
          cancelled: true,
        },
        expected: false,
      },
    ],
  },
  {
    id: "07-unicode",
    level: 7,
    title: "Unicode review routing",
    demonstrates: "Unicode enum values and optional nullable enum comparison",
    source: "examples/hybrid-wasm-scenarios/07-unicode/review-routing.ts",
    functionName: "canProceedWithReview",
    cases: [
      {
        name: "domestic-and-verified",
        input: { region: "日本", identityVerified: true },
        expected: true,
      },
      {
        name: "domestic-but-unverified",
        input: { region: "日本", identityVerified: false },
        expected: false,
      },
      {
        name: "overseas-manually-approved",
        input: {
          region: "海外",
          identityVerified: false,
          review: "承認",
        },
        expected: true,
      },
      {
        name: "overseas-rejected",
        input: {
          region: "海外",
          identityVerified: true,
          review: "却下",
        },
        expected: false,
      },
      {
        name: "overseas-without-review",
        input: { region: "海外", identityVerified: true, review: null },
        expected: false,
      },
    ],
  },
];
