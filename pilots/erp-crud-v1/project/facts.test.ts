import { describe, expect, test } from "bun:test";

import {
  inventoryDiscrepancyReviewInput,
  priceReviewInput,
  productArchiveReviewInput,
  quantityReviewInput,
  shipmentPreparationReviewInput,
} from "./facts";

describe("ERP Pilot exact facts", () => {
  test("derives review facts without performing business writes", () => {
    expect(
      productArchiveReviewInput({
        productCode: "P-1",
        displayName: "Fixture",
        categoryCode: "C-1",
        lifecycle: "discontinued",
        onHandQuantity: 0,
        openShipmentCount: 0,
      }),
    ).toEqual({
      lifecycle: "discontinued",
      inventoryState: "zero",
      openShipmentState: "none",
    });
    expect(
      priceReviewInput({
        unitPrice: 1200,
        currencyCode: "JPY",
        taxCategoryCode: "standard",
      }),
    ).toEqual({
      currencyCode: "JPY",
      amountState: "entered",
      taxCategoryCode: "standard",
    });
    expect(quantityReviewInput({ quantity: -1, unitCode: "EA" })).toEqual({
      quantityState: "invalid",
      unitCode: "EA",
    });
    expect(
      inventoryDiscrepancyReviewInput({
        sku: "SKU-1",
        locationCode: "TOKYO",
        recordedQuantity: 10,
        countedQuantity: 9,
        countedBy: "reviewer-1",
      }),
    ).toEqual({
      discrepancyState: "detected",
      countedBy: "reviewer-1",
    });
    expect(
      shipmentPreparationReviewInput({
        shipmentId: "S-1",
        lifecycle: "queued",
        destinationCode: "TOKYO",
        addressValidated: true,
        inventoryPrepared: true,
        exceptionCode: null,
        assigneeId: null,
      }),
    ).toEqual({
      lifecycle: "queued",
      destinationCode: "TOKYO",
      addressValidation: "valid",
      inventoryPreparation: "ready",
    });
  });
});
