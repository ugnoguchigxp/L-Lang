import type {
  InventoryDiscrepancyReviewInput,
  InventoryRecord,
  InventoryReviewInput,
  PriceRecord,
  PriceReviewInput,
  ProductArchiveReviewInput,
  ProductMasterRecord,
  ProductMasterReviewInput,
  QuantityRecord,
  QuantityReviewInput,
  ShipmentExceptionReviewInput,
  ShipmentPreparationReviewInput,
  ShipmentRecord,
} from "./types";

export function productMasterReviewInput(
  record: ProductMasterRecord,
): ProductMasterReviewInput {
  return {
    productCode: record.productCode,
    displayName: record.displayName,
    categoryCode: record.categoryCode,
    lifecycle: record.lifecycle,
  };
}

export function productArchiveReviewInput(
  record: ProductMasterRecord,
): ProductArchiveReviewInput {
  return {
    lifecycle: record.lifecycle,
    inventoryState: quantityPresence(
      record.onHandQuantity,
      "zero",
      "remaining",
    ),
    openShipmentState: quantityPresence(
      record.openShipmentCount,
      "none",
      "present",
    ),
  };
}

export function priceReviewInput(record: PriceRecord): PriceReviewInput {
  return {
    currencyCode: record.currencyCode,
    amountState:
      record.unitPrice === null
        ? "missing"
        : Number.isFinite(record.unitPrice) && record.unitPrice >= 0
          ? "entered"
          : "invalid",
    taxCategoryCode: record.taxCategoryCode,
  };
}

export function quantityReviewInput(
  record: QuantityRecord,
): QuantityReviewInput {
  return {
    quantityState:
      record.quantity === null
        ? "unknown"
        : Number.isFinite(record.quantity) && record.quantity >= 0
          ? "valid"
          : "invalid",
    unitCode: record.unitCode,
  };
}

export function inventoryReviewInput(
  record: InventoryRecord,
): InventoryReviewInput {
  return {
    sku: record.sku,
    locationCode: record.locationCode,
    countState: record.countedQuantity === null ? "not_counted" : "counted",
  };
}

export function inventoryDiscrepancyReviewInput(
  record: InventoryRecord,
): InventoryDiscrepancyReviewInput {
  return {
    discrepancyState:
      record.recordedQuantity === null || record.countedQuantity === null
        ? "unknown"
        : Object.is(record.recordedQuantity, record.countedQuantity)
          ? "none"
          : "detected",
    countedBy: record.countedBy,
  };
}

export function shipmentPreparationReviewInput(
  record: ShipmentRecord,
): ShipmentPreparationReviewInput {
  return {
    lifecycle: record.lifecycle,
    destinationCode: record.destinationCode,
    addressValidation: booleanFact(record.addressValidated, "valid", "invalid"),
    inventoryPreparation: booleanFact(
      record.inventoryPrepared,
      "ready",
      "not_ready",
    ),
  };
}

export function shipmentExceptionReviewInput(
  record: ShipmentRecord,
): ShipmentExceptionReviewInput {
  return {
    exceptionState: record.exceptionCode === null ? "none" : "open",
    assigneeId: record.assigneeId,
  };
}

function quantityPresence<Zero extends string, Positive extends string>(
  value: number | null,
  zero: Zero,
  positive: Positive,
): Zero | Positive | "unknown" {
  if (value === null || !Number.isFinite(value) || value < 0) return "unknown";
  return value === 0 ? zero : positive;
}

function booleanFact<True extends string, False extends string>(
  value: boolean | null,
  whenTrue: True,
  whenFalse: False,
): True | False | "unknown" {
  return value === null ? "unknown" : value ? whenTrue : whenFalse;
}
