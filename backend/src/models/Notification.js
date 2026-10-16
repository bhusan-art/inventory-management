import mongoose from 'mongoose';

/**
 * Internal notifications.
 *
 * Arrives in Phase 4 rather than Phase 11 because the reconciliation job needs
 * somewhere to report drift. A watchdog that detects a problem and has no way
 * to tell anyone is not a watchdog.
 */
const notificationSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    /** Either a specific user, or everyone holding a permission. */
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recipientPermission: { type: String, default: null },

    type: { type: String, required: true, index: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, maxlength: 1000 },
    severity: { type: String, enum: ['INFO', 'NOTICE', 'WARNING', 'CRITICAL'], default: 'INFO' },

    module: { type: String, default: null },
    recordId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actionUrl: { type: String, default: null },

    /**
     * Stops the same alert being raised on every scheduled run.
     *
     * A low-stock job running four times a day would otherwise generate four
     * identical notifications daily until somebody reorders — which trains
     * people to ignore the notification list entirely.
     */
    dedupeKey: { type: String, required: true },

    /**
     * Read state is PER USER, not per notification.
     *
     * The original design had a single `readAt` on the document, which is
     * correct only for a notification addressed to one person. Most are
     * addressed to a PERMISSION — every holder of ASSIGN_SERVICE_REQUEST sees
     * the same row — and with one shared field the first person to open their
     * inbox marked it read for the entire team. A CRITICAL SLA alert would
     * vanish from everyone else's unread list because a colleague glanced at
     * it. That is precisely the alert you cannot afford to lose.
     *
     * So each reader records themselves. "Unread" means this user is not in
     * the list, which is a question about the pair (notification, user) and
     * has to be stored as one.
     */
    readBy: [{
      _id: false,
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      at: { type: Date, default: Date.now },
    }],

    /** @deprecated Superseded by `readBy`; retained so the migration can read it. */
    readAt: { type: Date, default: null },

    expiresAt: { type: Date, default: null, index: { expires: 0 } },
  },
  { timestamps: true },
);

notificationSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ tenantId: 1, recipient: 1, createdAt: -1 });
notificationSchema.index({ tenantId: 1, recipientPermission: 1, createdAt: -1 });
// Drives the unread count, which runs on every page load of the bell.
notificationSchema.index({ tenantId: 1, 'readBy.user': 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;
