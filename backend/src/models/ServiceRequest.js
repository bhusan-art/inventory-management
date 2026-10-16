import mongoose from 'mongoose';

const activitySchema = new mongoose.Schema(
  {
    fromStatus: String,
    toStatus: { type: String, required: true },
    note: { type: String, trim: true, maxlength: 1000 },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const serviceRequestSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    ticketNumber: { type: String, required: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    serialNumber: { type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber', default: null },
    warranty: { type: mongoose.Schema.Types.ObjectId, ref: 'Warranty', default: null },

    /**
     * Entitlement, SNAPSHOTTED when the ticket is raised.
     *
     * A warranty can expire while a unit sits in the workshop. The customer
     * reported the fault while covered, so the repair is covered — deciding
     * entitlement at closing time would charge people for the queue they waited
     * in. Once written, this never changes.
     */
    warrantyApplicable: { type: Boolean, required: true },
    warrantyEndDateAtRaise: { type: Date, default: null },

    issueDescription: { type: String, required: true, trim: true, maxlength: 2000 },
    reportedDate: { type: Date, required: true, default: Date.now },
    priority: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM', index: true },
    slaDueDate: { type: Date, default: null },

    status: {
      type: String,
      enum: ['OPEN', 'UNDER_INSPECTION', 'SENT_TO_VENDOR', 'UNDER_REPAIR',
        'REPAIRED', 'REPLACED', 'REJECTED', 'CLOSED'],
      default: 'OPEN',
      index: true,
    },

    /** Set once the physical unit arrives at a service location. */
    receivedAtWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    receivedAt: { type: Date, default: null },
    returnedAt: { type: Date, default: null },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    vendorRmaNumber: { type: String, trim: true, maxlength: 60, default: null },

    replacementSerialNumber: { type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber', default: null },
    rootCause: { type: String, trim: true, maxlength: 1000, default: null },
    resolution: { type: String, trim: true, maxlength: 2000, default: null },

    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    activity: { type: [activitySchema], default: [] },
    documents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],

    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

serviceRequestSchema.index({ tenantId: 1, ticketNumber: 1 }, { unique: true });
serviceRequestSchema.index({ tenantId: 1, status: 1, priority: 1 });
serviceRequestSchema.index({ tenantId: 1, serialNumber: 1, createdAt: -1 });
serviceRequestSchema.index({ tenantId: 1, customer: 1, createdAt: -1 });
serviceRequestSchema.index({ tenantId: 1, assignedTo: 1, status: 1 });
serviceRequestSchema.index({ tenantId: 1, slaDueDate: 1, status: 1 });

/**
 * Which statuses a ticket may move to next.
 *
 * Same reasoning as the serial transition table: a status that can be set to
 * anything is a status that eventually disagrees with what happened.
 */
export const SERVICE_TRANSITIONS = Object.freeze({
  OPEN: ['UNDER_INSPECTION', 'REJECTED', 'CLOSED'],
  UNDER_INSPECTION: ['UNDER_REPAIR', 'SENT_TO_VENDOR', 'REPLACED', 'REJECTED'],
  SENT_TO_VENDOR: ['UNDER_REPAIR', 'REPAIRED', 'REPLACED', 'REJECTED'],
  UNDER_REPAIR: ['REPAIRED', 'REPLACED', 'REJECTED'],
  REPAIRED: ['CLOSED'],
  REPLACED: ['CLOSED'],
  REJECTED: ['CLOSED'],
  CLOSED: [],
});

export function canMoveService(from, to) {
  return (SERVICE_TRANSITIONS[from] ?? []).includes(to);
}

export const ServiceRequest = mongoose.model('ServiceRequest', serviceRequestSchema);
export default ServiceRequest;
