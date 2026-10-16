import { Notification } from '../../models/Notification.js';
import logger from '../../config/logger.js';
import { assertKnownPermission } from '../../constants/permissions.js';

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

  /**
   * A notification addressed to a permission nobody holds reaches NOBODY, and
   * says nothing about it.
   *
   * `recipientPermission` is a free string on the model, so a typo —
   * 'CREATE_DISPATCH_NOTE' for 'CREATE_DISPATCH' — produces a row that is
   * written successfully, counted in the database, and delivered to no one.
   * There is no error, no empty inbox to notice, nothing: the alert simply
   * does not exist for any human being. Exactly the failure the audit-severity
   * bug had, one layer over.
   *
   * Throwing is correct rather than harsh. Every call site is our own code
   * with a literal string, so this can only fire in development — and it fires
   * the first time the line is exercised rather than during the incident the
   * alert was meant to warn about.
   */
  if (recipientPermission) assertKnownPermission(recipientPermission);

  if (!recipient && !recipientPermission) {
    throw new Error(`notify(${type}) has no recipient and no recipientPermission — it would reach nobody`);
  }

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

/**
 * The notifications this actor can see: addressed to them, or to a permission
 * they hold.
 *
 * `readBy` is consulted per user. The old `readAt` could not express this: one
 * person reading a permission-addressed alert hid it from everyone.
 */
function visibleTo(actor) {
  return {
    tenantId: actor.tenantId,
    $or: [
      { recipient: actor.id },
      { recipientPermission: { $in: [...actor.permissions] } },
    ],
  };
}

/** Unread FOR THIS USER — they are not among the readers. */
function unreadBy(actor) {
  return { ...visibleTo(actor), 'readBy.user': { $ne: actor.id } };
}

export async function listNotifications(actor, { unreadOnly = false, severity, type, page = 1, limit = 25 } = {}) {
  const filter = unreadOnly ? unreadBy(actor) : visibleTo(actor);
  if (severity) filter.severity = severity;
  if (type) filter.type = type;

  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments(unreadBy(actor)),
  ]);

  const readerId = String(actor.id);

  return {
    items: items.map((n) => ({
      doc: n,
      // Computed per reader rather than stored on the row.
      read: (n.readBy ?? []).some((r) => String(r.user) === readerId),
    })),
    meta: { page, limit, total, unread, pages: Math.ceil(total / limit) || 1 },
  };
}

export async function unreadCount(actor) {
  return Notification.countDocuments(unreadBy(actor));
}

/**
 * Records that THIS user has read it. Idempotent: `$addToSet` on the user id
 * means a double click does not append a second entry.
 */
export async function markRead(actor, id) {
  return Notification.findOneAndUpdate(
    { _id: id, ...visibleTo(actor), 'readBy.user': { $ne: actor.id } },
    { $addToSet: { readBy: { user: actor.id, at: new Date() } } },
    { new: true },
  );
}

/** Marks everything this user can currently see as read by them, and nobody else. */
export async function markAllRead(actor) {
  const result = await Notification.updateMany(
    unreadBy(actor),
    { $addToSet: { readBy: { user: actor.id, at: new Date() } } },
  );
  return result.modifiedCount;
}

/** Undo, because a mis-click on "mark all read" should not be permanent. */
export async function markUnread(actor, id) {
  return Notification.findOneAndUpdate(
    { _id: id, ...visibleTo(actor) },
    { $pull: { readBy: { user: actor.id } } },
    { new: true },
  );
}

export { visibleTo, unreadBy };
