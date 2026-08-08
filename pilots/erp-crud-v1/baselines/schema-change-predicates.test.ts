import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  isInventoryRecordReviewReadyV2,
  isPriceRecordReviewReadyV2,
  isProductArchiveReviewCandidateV2,
  isProductMasterReviewReadyV2,
  isShipmentPreparationReviewReadyV2,
  needsInventoryDiscrepancyReviewV2,
  needsQuantityDataReviewV2,
  needsShipmentExceptionReviewV2,
} from "./schema-change-predicates";

type HiddenCase = {
  name: string;
  input: never;
  expected: boolean;
};

describe("ERP Pilot schema-change baselines", () => {
  test("matches every changed-schema hidden expectation", async () => {
    const hidden = JSON.parse(
      await readFile(
        resolve(import.meta.dir, "../cases/schema-change-hidden-cases.json"),
        "utf8",
      ),
    ) as { cases: Record<string, HiddenCase[]> };
    const predicates: Record<string, (input: never) => boolean> = {
      "product-master-review-ready": isProductMasterReviewReadyV2,
      "product-archive-review-candidate": isProductArchiveReviewCandidateV2,
      "price-record-review-ready": isPriceRecordReviewReadyV2,
      "quantity-data-review": needsQuantityDataReviewV2,
      "inventory-record-review-ready": isInventoryRecordReviewReadyV2,
      "inventory-discrepancy-review": needsInventoryDiscrepancyReviewV2,
      "shipment-preparation-review-ready": isShipmentPreparationReviewReadyV2,
      "shipment-exception-review": needsShipmentExceptionReviewV2,
    };
    expect(Object.keys(hidden.cases).sort()).toEqual(
      Object.keys(predicates).sort(),
    );
    for (const [caseId, cases] of Object.entries(hidden.cases)) {
      const predicate = predicates[caseId];
      expect(predicate).toBeDefined();
      if (predicate === undefined) {
        throw new Error(`missing changed-schema baseline predicate ${caseId}`);
      }
      for (const entry of cases) {
        expect(predicate(entry.input), `${caseId}: ${entry.name}`).toBe(
          entry.expected,
        );
      }
    }
  });
});
