/**
 * Date arithmetic for warranty periods.
 *
 * `setMonth` overflows: 31 Jan + 1 month becomes 3 March, because 31 February
 * does not exist and JavaScript rolls forward rather than clamping. A warranty
 * sold on 31 January for 1 month would expire on 3 March — three days of free
 * cover, every time, forever.
 *
 * So months are added by hand and the day is clamped to the last day of the
 * target month.
 */
export function addMonths(date, months) {
  const source = new Date(date);
  const day = source.getDate();

  const result = new Date(source);
  result.setDate(1);                        // avoid the overflow before it happens
  result.setMonth(result.getMonth() + months);

  const lastDayOfTargetMonth = new Date(
    result.getFullYear(), result.getMonth() + 1, 0,
  ).getDate();

  result.setDate(Math.min(day, lastDayOfTargetMonth));
  return result;
}

/** Whole days between two dates, ignoring the time of day. */
export function daysBetween(from, to) {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

export const EXPIRING_SOON_DAYS = 30;

/**
 * Warranty status, computed — never stored (ARCHITECTURE.md §0.2).
 *
 * Storing it would mean a nightly job writing to every sold asset forever just
 * to record the passage of time, and a corrected date would not fix past
 * reports. Derived here, a date correction is instantly right everywhere.
 */
export function warrantyStatus(warranty, now = new Date()) {
  if (!warranty) return null;
  if (warranty.state === 'VOID') return 'VOID';
  if (warranty.state === 'CLAIMED_REPLACED') return 'REPLACED';

  const end = new Date(warranty.endDate);
  const remaining = daysBetween(now, end);

  if (remaining < 0) return 'EXPIRED';
  if (remaining <= EXPIRING_SOON_DAYS) return 'EXPIRING_SOON';
  return 'ACTIVE';
}

export function daysRemaining(warranty, now = new Date()) {
  if (!warranty) return null;
  return daysBetween(now, new Date(warranty.endDate));
}
