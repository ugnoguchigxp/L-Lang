export type ProductMasterRecord = {
  productCode: string | null;
  displayName: string | null;
  categoryCode: string | null;
  lifecycle: "draft" | "active" | "discontinued";
  onHandQuantity: number | null;
  openShipmentCount: number | null;
};

export type PriceRecord = {
  unitPrice: number | null;
  currencyCode: string | null;
  taxCategoryCode: string | null;
};

export type QuantityRecord = {
  quantity: number | null;
  unitCode: string | null;
};

export type InventoryRecord = {
  sku: string | null;
  locationCode: string | null;
  recordedQuantity: number | null;
  countedQuantity: number | null;
  countedBy: string | null;
};

export type ShipmentRecord = {
  shipmentId: string;
  lifecycle: "draft" | "queued" | "preparing" | "shipped";
  destinationCode: string | null;
  addressValidated: boolean | null;
  inventoryPrepared: boolean | null;
  exceptionCode: string | null;
  assigneeId: string | null;
};

export type ProductMasterReviewInput = {
  productCode: string | null;
  displayName: string | null;
  categoryCode: string | null;
  lifecycle: "draft" | "active" | "discontinued";
};

export type ProductArchiveReviewInput = {
  lifecycle: "draft" | "active" | "discontinued";
  inventoryState: "zero" | "remaining" | "unknown";
  openShipmentState: "none" | "present" | "unknown";
};

export type PriceReviewInput = {
  currencyCode: string | null;
  amountState: "missing" | "entered" | "invalid";
  taxCategoryCode: string | null;
};

export type QuantityReviewInput = {
  quantityState: "valid" | "invalid" | "unknown";
  unitCode: string | null;
};

export type InventoryReviewInput = {
  sku: string | null;
  locationCode: string | null;
  countState: "not_counted" | "counted";
};

export type InventoryDiscrepancyReviewInput = {
  discrepancyState: "none" | "detected" | "unknown";
  countedBy: string | null;
};

export type ShipmentPreparationReviewInput = {
  lifecycle: "draft" | "queued" | "preparing" | "shipped";
  destinationCode: string | null;
  addressValidation: "valid" | "invalid" | "unknown";
  inventoryPreparation: "ready" | "not_ready" | "unknown";
};

export type ShipmentExceptionReviewInput = {
  exceptionState: "none" | "open";
  assigneeId: string | null;
};
