import { BaseRepository } from './baseRepository.js';
import { Vendor } from '../models/Vendor.js';

class VendorRepository extends BaseRepository {
  constructor() {
    super(Vendor, { tenantScoped: true, softDelete: true });
  }

  /**
   * Full, unmasked bank details.
   *
   * Named and confined here for the same reason the credential reads are:
   * every place the application can produce a complete account number should
   * be findable in one grep. The caller is responsible for the permission
   * check and the audit entry.
   */
  findByIdWithBankDetails(id, ctx = {}) {
    return Vendor.findOne(this.scopeFilter({ _id: id }, ctx)).select('+bankDetails');
  }
}

export const vendorRepository = new VendorRepository();
export default vendorRepository;
