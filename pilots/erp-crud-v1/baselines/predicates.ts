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

export function isProductMasterReviewReady(
  value: ProductMasterReviewInput,
): boolean {
  return (
    value.lifecycle === "draft" &&
    value.productCode !== null &&
    value.displayName !== null &&
    value.categoryCode !== null
  );
}

export function isProductArchiveReviewCandidate(
  value: ProductArchiveReviewInput,
): boolean {
  return (
    value.lifecycle === "discontinued" &&
    value.inventoryState === "zero" &&
    value.openShipmentState === "none"
  );
}

export function isPriceRecordReviewReady(value: PriceReviewInput): boolean {
  return (
    value.amountState === "entered" &&
    value.currencyCode !== null &&
    value.taxCategoryCode !== null
  );
}

export function needsQuantityDataReview(value: QuantityReviewInput): boolean {
  return value.quantityState === "invalid" || value.unitCode === null;
}

export function isInventoryRecordReviewReady(
  value: InventoryReviewInput,
): boolean {
  return (
    value.countState === "counted" &&
    value.sku !== null &&
    value.locationCode !== null
  );
}

export function needsInventoryDiscrepancyReview(
  value: InventoryDiscrepancyReviewInput,
): boolean {
  return value.discrepancyState === "detected" && value.countedBy !== null;
}

export function isShipmentPreparationReviewReady(
  value: ShipmentPreparationReviewInput,
): boolean {
  return (
    value.lifecycle === "queued" &&
    value.destinationCode !== null &&
    value.addressValidation === "valid" &&
    value.inventoryPreparation === "ready"
  );
}

export function needsShipmentExceptionReview(
  value: ShipmentExceptionReviewInput,
): boolean {
  return value.exceptionState === "open" && value.assigneeId !== null;
}
