/**
 * Migrates notification read state from the shared `readAt` to per-user `readBy`.
 *
 * Run once, after deploying the Phase 11 code:
 *
 *   docker compose exec backend node src/db/migrations/001-notification-read-state.mjs
 *
 * Two cases, treated differently and deliberately:
 *
 *   recipient set       We know exactly who read it, so the timestamp converts
 *                       cleanly into one `readBy` entry.
 *
 *   recipient null      Addressed to a PERMISSION. `readAt` tells us somebody
 *                       read it but not who, and that information is simply
 *                       gone. These are left UNREAD for everyone.
 *
 * The second choice is the conservative one. Guessing a reader would mark an
 * alert read for people who never saw it; leaving it unread means a few stale
 * rows reappear in some inboxes once. A notification surfacing twice is a
 * nuisance; one silently buried is the failure this whole change exists to fix.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import { Notification } from '../../models/Notification.js';
import logger from '../../config/logger.js';

async function run() {
  await connectDatabase({ retries: 3, delayMs: 1000 });

  const addressed = await Notification.find({
    readAt: { $ne: null },
    recipient: { $ne: null },
    readBy: { $size: 0 },
  }).select('_id recipient readAt');

  let migrated = 0;
  for (const n of addressed) {
    await Notification.updateOne(
      { _id: n._id },
      { $addToSet: { readBy: { user: n.recipient, at: n.readAt } } },
    );
    migrated += 1;
  }

  const unattributable = await Notification.countDocuments({
    readAt: { $ne: null }, recipient: null, readBy: { $size: 0 },
  });

  logger.info(
    { migrated, unattributable },
    'Notification read state migrated — unattributable rows left unread on purpose',
  );

  await mongoose.connection.close();
  await disconnectDatabase().catch(() => {});
}

run().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exitCode = 1;
});
