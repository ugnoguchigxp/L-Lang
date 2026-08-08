import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  isInventoryRecordReviewReady,
  isPriceRecordReviewReady,
  isProductArchiveReviewCandidate,
  isProductMasterReviewReady,
  isShipmentPreparationReviewReady,
  needsInventoryDiscrepancyReview,
  needsQuantityDataReview,
  needsShipmentExceptionReview,
} from "./predicates";
import type {
  InventoryDiscrepancyReviewInput,
  InventoryReviewInput,
  PriceReviewInput,
  ProductArchiveReviewInput,
  ProductMasterReviewInput,
  QuantityReviewInput,
  ShipmentExceptionReviewInput,
  ShipmentPreparationReviewInput,
} from "../project/types";

type HiddenCase = {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
};

describe("ERP Pilot handwritten baselines", () => {
  test("matches every frozen hidden expectation", async () => {
    const hidden = JSON.parse(
      await readFile(
        resolve(import.meta.dir, "../cases/hidden-cases.json"),
        "utf8",
      ),
    ) as { cases: Record<string, HiddenCase[]> };
    const predicates: Record<
      string,
      (input: Record<string, unknown>) => boolean
    > = {
      "product-master-review-ready": (input) =>
        isProductMasterReviewReady(input as ProductMasterReviewInput),
      "product-archive-review-candidate": (input) =>
        isProductArchiveReviewCandidate(input as ProductArchiveReviewInput),
      "price-record-review-ready": (input) =>
        isPriceRecordReviewReady(input as PriceReviewInput),
      "quantity-data-review": (input) =>
        needsQuantityDataReview(input as QuantityReviewInput),
      "inventory-record-review-ready": (input) =>
        isInventoryRecordReviewReady(input as InventoryReviewInput),
      "inventory-discrepancy-review": (input) =>
        needsInventoryDiscrepancyReview(
          input as InventoryDiscrepancyReviewInput,
        ),
      "shipment-preparation-review-ready": (input) =>
        isShipmentPreparationReviewReady(
          input as ShipmentPreparationReviewInput,
        ),
      "shipment-exception-review": (input) =>
        needsShipmentExceptionReview(input as ShipmentExceptionReviewInput),
    };
    expect(Object.keys(hidden.cases).sort()).toEqual(
      Object.keys(predicates).sort(),
    );
    for (const [caseId, cases] of Object.entries(hidden.cases)) {
      const predicate = predicates[caseId];
      expect(predicate).toBeDefined();
      if (predicate === undefined) {
        throw new Error(`missing baseline predicate ${caseId}`);
      }
      for (const entry of cases) {
        expect(predicate(entry.input), `${caseId}: ${entry.name}`).toBe(
          entry.expected,
        );
      }
    }
  });
});
