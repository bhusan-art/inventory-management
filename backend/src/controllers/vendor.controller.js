import asyncHandler from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import { Vendor } from '../models/Vendor.js';
import { vendorRepository } from '../repositories/vendor.repository.js';
import { writeAudit } from '../services/shared/auditService.js';
import { NotFoundError } from '../utils/errors.js';

/**
 * Unmasked vendor bank details.
 *
 * A separate endpoint rather than a field on the vendor record, for three
 * reasons: it keeps full account numbers off list screens and out of browser
 * history; it makes every read of a full account number a single auditable
 * event rather than a side effect of loading a page; and it means the
 * permission can be granted without every vendor view becoming sensitive.
 */
export const getBankDetails = asyncHandler(async (req, res) => {
  const vendor = await vendorRepository.findByIdWithBankDetails(req.params.id, {
    tenantId: req.actor.tenantId,
  });
  if (!vendor) throw new NotFoundError('Vendor not found');

  await writeAudit({
    action: 'VENDOR_BANK_DETAILS_VIEWED',
    module: 'Vendor',
    recordId: vendor._id,
    recordLabel: vendor.vendorCode,
    severity: 'WARNING',
    tenantId: req.actor.tenantId,
  });

  return ok(res, {
    data: {
      vendorId: String(vendor._id),
      vendorName: vendor.vendorName,
      bankDetails: vendor.bankDetails ?? null,
    },
  });
});

export { Vendor };
