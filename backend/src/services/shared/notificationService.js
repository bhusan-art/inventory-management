import { Notification } from '../../models/Notification.js';
import logger from '../../config/logger.js';

/**
 * Raises a notification, deduplicated.
 *
 * `dedupeKey` carries the date for recurring conditions, so a low-stock alert
 * fires once per product per day rather than once per job run. Without it the
 * notification list fills with identical rows and people stop reading it —
 * which is worse than having no alerts, because now you believe you have them.
 */
export async function notify({
  tenantId, type, title, body, severity = 'INFO',
  recipient = null, recipientPermission = null,
  module = null, recordId = null, actionUrl = null,
  dedupeKey, expiresInDays = 30,
}) {
  if (!dedupeKey) throw new Error('notify requires a dedupeKey');

  try {
    await Notification.create({
      tenantId, type, title, body, severity,
      recipient, recipientPermission, module, recordId, actionUrl, dedupeKey,
      expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
    });
    return true;
  } catch (err) {
    // Duplicate key means this alert already exists — the dedupe working, not
    // a failure.
    if (err.code === 11000) return false;
    logger.error({ err, type }, 'Failed to raise notification');
    return false;
  }
}

export async function listNotifications(actor, { unreadOnly = false, page = 1, limit = 25 } = {}) {
  // A user sees notifications addressed to them personally, plus those
  // addressed to a permission they hold.
  const filter = {
    tenantId: actor.tenantId,
    $or: [
      { recipient: actor.id },
      { recipientPermission: { $in: [...actor.permissions] } },
    ],
  };
  if (unreadOnly) filter.readAt = null;

  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);

  return { items, meta: { page, limit, total, unread, pages: Math.ceil(total / limit) || 1 } };
}

export async function markRead(actor, id) {
  return Notification.findOneAndUpdate(
    {
      _id: id,
      tenantId: actor.tenantId,
      $or: [{ recipient: actor.id }, { recipientPermission: { $in: [...actor.permissions] } }],
    },
    { $set: { readAt: new Date() } },
    { new: true },
  );
}

export async function markAllRead(actor) {
  const result = await Notification.updateMany(
    {
      tenantId: actor.tenantId,
      readAt: null,
      $or: [{ recipient: actor.id }, { recipientPermission: { $in: [...actor.permissions] } }],
    },
    { $set: { readAt: new Date() } },
  );
  return result.modifiedCount;
}
