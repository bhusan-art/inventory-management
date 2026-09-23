import mongoose from 'mongoose';

/**
 * Tenant configuration, one document per key.
 *
 * Values that operations staff will want to tune — adjustment thresholds,
 * alert windows, receipt tolerance — belong here rather than in code, so
 * changing them is a decision rather than a deployment.
 */
const settingSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    key: { type: String, required: true, maxlength: 80 },
    value: mongoose.Schema.Types.Mixed,
    description: { type: String, maxlength: 300 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

settingSchema.index({ tenantId: 1, key: 1 }, { unique: true });

export const Setting = mongoose.model('Setting', settingSchema);

/**
 * Defaults live in code so the system works before anything is configured, and
 * so a missing setting can never be the reason a stock movement fails.
 */
export const SETTING_DEFAULTS = Object.freeze({
  'inventory.adjustmentThreshold.units': 10,
  'inventory.adjustmentThreshold.percent': 5,
  'inventory.overReceiptTolerancePercent': 0,
  'warranty.alertDays': [30, 15, 7, 0],
  'reservation.staleAfterDays': 7,
});

export async function getSetting(tenantId, key) {
  const doc = await Setting.findOne({ tenantId, key }).lean();
  return doc ? doc.value : SETTING_DEFAULTS[key];
}

export async function getSettings(tenantId, keys) {
  const docs = await Setting.find({ tenantId, key: { $in: keys } }).lean();
  const found = new Map(docs.map((d) => [d.key, d.value]));
  return Object.fromEntries(keys.map((k) => [k, found.has(k) ? found.get(k) : SETTING_DEFAULTS[k]]));
}

export default Setting;
