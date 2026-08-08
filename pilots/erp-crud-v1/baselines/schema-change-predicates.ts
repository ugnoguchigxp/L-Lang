import type { InventoryDiscrepancyReviewV2 } from "../schema-changes/inventory-discrepancy-review.semantic";
import type { InventoryReviewV2 } from "../schema-changes/inventory-record-review-ready.semantic";
import type { PriceReviewV2 } from "../schema-changes/price-record-review-ready.semantic";
import type { ProductArchiveReviewV2 } from "../schema-changes/product-archive-review-candidate.semantic";
import type { ProductMasterReviewV2 } from "../schema-changes/product-master-review-ready.semantic";
import type { QuantityReviewV2 } from "../schema-changes/quantity-data-review.semantic";
import type { ShipmentExceptionReviewV2 } from "../schema-changes/shipment-exception-review.semantic";
import type { ShipmentPreparationReviewV2 } from "../schema-changes/shipment-preparation-review-ready.semantic";

export function isProductMasterReviewReadyV2(
  value: ProductMasterReviewV2,
): boolean {
  return (
    value.state === "draft" &&
    value.identity.code !== null &&
    value.identity.name !== null &&
    value.identity.category !== null
  );
}

export function isProductArchiveReviewCandidateV2(
  value: ProductArchiveReviewV2,
): boolean {
  return (
    value.status === "discontinued" &&
    value.stock.state === "zero" &&
    value.shipping.openWork === "none"
  );
}

export function isPriceRecordReviewReadyV2(value: PriceReviewV2): boolean {
  return (
    value.money.validation === "entered" &&
    value.money.currency !== null &&
    value.tax.category !== null
  );
}

export function needsQuantityDataReviewV2(value: QuantityReviewV2): boolean {
  return (
    value.validation.state === "invalid" || value.measurement.unit === null
  );
}

export function isInventoryRecordReviewReadyV2(
  value: InventoryReviewV2,
): boolean {
  return (
    value.count.lifecycle === "counted" &&
    value.item.sku !== null &&
    value.site.code !== null
  );
}

export function needsInventoryDiscrepancyReviewV2(
  value: InventoryDiscrepancyReviewV2,
): boolean {
  return value.variance.status === "detected" && value.audit.countedBy !== null;
}

export function isShipmentPreparationReviewReadyV2(
  value: ShipmentPreparationReviewV2,
): boolean {
  return (
    value.workflow.status === "queued" &&
    value.destination.code !== null &&
    value.destination.validation === "valid" &&
    value.inventory.status === "ready"
  );
}

export function needsShipmentExceptionReviewV2(
  value: ShipmentExceptionReviewV2,
): boolean {
  return (
    value.exception.status === "open" && value.ownership.assigneeId !== null
  );
}
