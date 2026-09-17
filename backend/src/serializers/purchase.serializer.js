const ref = (v) => (v && typeof v === 'object' && v._id
  ? {
      id: String(v._id),
      name: v.name ?? v.vendorName ?? v.fullName ?? null,
      code: v.code ?? v.vendorCode ?? v.sku ?? null,
    }
  : v ? String(v) : null);

export function serializePurchaseOrder(po) {
  if (!po) return null;
  const d = po.toObject ? po.toObject() : po;

  const lines = (d.lines ?? []).map((l) => {
    const settled = l.receivedQuantity + l.rejectedQuantity + l.shortClosedQuantity;
    return {
      id: String(l._id),
      product: ref(l.product),
      orderedQuantity: l.orderedQuantity,
      receivedQuantity: l.receivedQuantity,
      rejectedQuantity: l.rejectedQuantity,
      shortClosedQuantity: l.shortClosedQuantity,
      // Computed rather than stored: a stored "pending" drifts the moment a
      // receipt is posted, and there is no benefit to keeping it.
      outstandingQuantity: Math.max(0, l.orderedQuantity - settled),
      remarks: l.remarks ?? null,
    };
  });

  return {
    id: String(d._id),
    poNumber: d.poNumber,
    vendor: ref(d.vendor),
    warehouse: ref(d.warehouse),
    orderDate: d.orderDate,
    expectedDeliveryDate: d.expectedDeliveryDate ?? null,
    status: d.status,
    lines,
    totals: {
      ordered: lines.reduce((s, l) => s + l.orderedQuantity, 0),
      received: lines.reduce((s, l) => s + l.receivedQuantity, 0),
      outstanding: lines.reduce((s, l) => s + l.outstandingQuantity, 0),
    },
    requestedBy: ref(d.requestedBy),
    approvedBy: ref(d.approvedBy),
    approvedAt: d.approvedAt ?? null,
    closedReason: d.closedReason ?? null,
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function serializeGrn(grn) {
  if (!grn) return null;
  const d = grn.toObject ? grn.toObject() : grn;

  return {
    id: String(d._id),
    grnNumber: d.grnNumber,
    vendor: ref(d.vendor),
    warehouse: ref(d.warehouse),
    purchaseOrder: d.purchaseOrder && typeof d.purchaseOrder === 'object'
      ? { id: String(d.purchaseOrder._id), poNumber: d.purchaseOrder.poNumber, status: d.purchaseOrder.status }
      : d.purchaseOrder ? String(d.purchaseOrder) : null,
    vendorInvoiceNumber: d.vendorInvoiceNumber ?? null,
    vendorInvoiceDate: d.vendorInvoiceDate ?? null,
    vendorChallanNumber: d.vendorChallanNumber ?? null,
    receivedDate: d.receivedDate,
    receivedBy: ref(d.receivedBy),
    vehicleNumber: d.vehicleNumber ?? null,
    status: d.status,
    postedAt: d.postedAt ?? null,
    postedBy: ref(d.postedBy),
    cancelReason: d.cancelReason ?? null,
    lines: (d.lines ?? []).map((l) => ({
      id: String(l._id),
      product: ref(l.product),
      orderedQuantity: l.orderedQuantity,
      receivedQuantity: l.receivedQuantity,
      acceptedQuantity: l.acceptedQuantity,
      damagedQuantity: l.damagedQuantity,
      rejectedQuantity: l.rejectedQuantity,
      shortQuantity: l.shortQuantity,
      rackLocation: l.rackLocation ?? null,
      batchNumber: l.batchNumber ?? null,
      serialNumbers: l.serialNumbers ?? [],
      serialCount: (l.serialNumbers ?? []).length,
      remarks: l.remarks ?? null,
    })),
    totals: {
      received: (d.lines ?? []).reduce((s, l) => s + l.receivedQuantity, 0),
      accepted: (d.lines ?? []).reduce((s, l) => s + l.acceptedQuantity, 0),
      damaged: (d.lines ?? []).reduce((s, l) => s + l.damagedQuantity, 0),
      rejected: (d.lines ?? []).reduce((s, l) => s + l.rejectedQuantity, 0),
    },
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
  };
}

export function serializeInventory(row) {
  if (!row) return null;
  const d = row.toObject ? row.toObject() : row;
  return {
    id: String(d._id),
    product: ref(d.product),
    warehouse: ref(d.warehouse),
    rackLocation: d.rackLocation ?? null,
    available: d.availableQuantity,
    reserved: d.reservedQuantity,
    damaged: d.damagedQuantity,
    inTransit: d.inTransitQuantity,
    underService: d.underServiceQuantity,
    total: d.availableQuantity + d.reservedQuantity + d.damagedQuantity
      + d.inTransitQuantity + d.underServiceQuantity,
    lastTransactionAt: d.lastTransactionAt ?? null,
  };
}

export function serializeLedgerEntry(entry) {
  if (!entry) return null;
  const d = entry.toObject ? entry.toObject() : entry;
  return {
    id: String(d._id),
    transactionNumber: d.transactionNumber,
    transactionType: d.transactionType,
    direction: d.direction,
    product: ref(d.product),
    warehouse: ref(d.warehouse),
    serialNumber: d.serialNumber ? String(d.serialNumber) : null,
    bucketFrom: d.bucketFrom,
    bucketTo: d.bucketTo,
    quantityBefore: d.quantityBefore,
    quantityChange: d.quantityChange,
    quantityAfter: d.quantityAfter,
    reference: { type: d.referenceType, id: d.referenceId ? String(d.referenceId) : null, number: d.referenceNumber },
    reasonCode: d.reasonCode ?? null,
    performedBy: ref(d.performedBy),
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
  };
}
