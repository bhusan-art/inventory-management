import { BaseRepository } from './baseRepository.js';
import { User } from '../models/User.js';

class UserRepository extends BaseRepository {
  constructor() {
    super(User, { tenantScoped: true, softDelete: true });
  }

  /**
   * Authentication path only.
   *
   * Deliberately bypasses tenant scoping: at login we have an email and no
   * actor yet, so there is no tenant to scope by. Kept as a named, documented
   * method rather than letting callers pass `tenantScoped: false`, so that
   * every use of it is visible in a grep.
   */
  findForAuthentication(email) {
    return User.findOne({ email: String(email).toLowerCase(), deletedAt: null })
      .select('+passwordHash')
      .populate('role');
  }

  findWithRole(id, ctx = {}) {
    return this.findById(id, ctx).populate('role');
  }

  /**
   * Credential-bearing reads.
   *
   * `passwordHash` and the reset-token fields are `select: false`, so reading
   * them requires an explicit projection — and that is confined to this class
   * by an ESLint rule. Keeping these as three named methods means every place
   * the application can read a credential is visible in one file.
   */
  findByIdWithPassword(id) {
    return User.findOne({ _id: id, deletedAt: null }).select('+passwordHash');
  }

  findByResetToken(tokenHash) {
    return User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
      deletedAt: null,
    }).select('+passwordHash +passwordResetTokenHash +passwordResetExpiresAt');
  }

  findByEmailForReset(email) {
    return User.findOne({ email: String(email).toLowerCase(), deletedAt: null })
      .select('+passwordResetTokenHash +passwordResetExpiresAt');
  }
}

export const userRepository = new UserRepository();
export default userRepository;
