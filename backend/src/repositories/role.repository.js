import { BaseRepository } from './baseRepository.js';
import { Role } from '../models/Role.js';

class RoleRepository extends BaseRepository {
  constructor() {
    super(Role, { tenantScoped: true, softDelete: true });
  }

  findByCode(code, ctx = {}) {
    return this.findOne({ code: String(code).toUpperCase() }, ctx);
  }
}

export const roleRepository = new RoleRepository();
export default roleRepository;
