import { permittedRestrictedFields } from '../constants/restrictedFields.js';

/**
 * Repository base — ARCHITECTURE.md §5, layer 3, plus tenant isolation.
 *
 * Two responsibilities, both of which exist so that correctness does not depend
 * on every developer remembering something:
 *
 *  1. TENANT INJECTION. Every query gets `tenantId` merged in. A service that
 *     forgets it cannot leak across companies, because the service never builds
 *     the final filter.
 *
 *  2. RESTRICTED FIELD SELECTION. Restricted fields are `select: false`, so the
 *     only way to read one is an explicit `+field` projection. This class is
 *     the only place permitted to produce one, and it requires the actor's
 *     permission set to do so. An ESLint rule blocks `.select('+` everywhere
 *     else in src/.
 */
export class BaseRepository {
  constructor(model, { tenantScoped = true, softDelete = true } = {}) {
    this.model = model;
    this.modelName = model.modelName;
    this.tenantScoped = tenantScoped;
    this.softDelete = softDelete;
  }

  /**
   * @param {object} filter      caller's filter
   * @param {object} ctx         { tenantId, includeDeleted }
   */
  scopeFilter(filter = {}, { tenantId, includeDeleted = false } = {}) {
    const scoped = { ...filter };

    if (this.tenantScoped) {
      if (!tenantId) {
        throw new Error(
          `${this.modelName} is tenant-scoped; a tenantId is required. This is a programming ` +
            'error — the actor context was not threaded through.',
        );
      }
      scoped.tenantId = tenantId;
    }

    if (this.softDelete && !includeDeleted && scoped.deletedAt === undefined) {
      scoped.deletedAt = null;
    }

    return scoped;
  }

  /**
   * Builds the `+field +field` projection for whichever restricted fields the
   * actor is entitled to. Returns '' when none apply, which Mongoose treats as
   * "schema defaults", i.e. restricted fields stay hidden.
   */
  selectRestricted(permissions) {
    if (!permissions) return '';
    const allowed = permittedRestrictedFields(this.modelName, permissions);
    return allowed.map((f) => `+${f}`).join(' ');
  }

  applyRestricted(query, permissions) {
    const projection = this.selectRestricted(permissions);
    return projection ? query.select(projection) : query;
  }

  findOne(filter, ctx = {}) {
    const query = this.model.findOne(this.scopeFilter(filter, ctx));
    if (ctx.session) query.session(ctx.session);
    return this.applyRestricted(query, ctx.permissions);
  }

  findById(id, ctx = {}) {
    return this.findOne({ _id: id }, ctx);
  }

  find(filter, ctx = {}) {
    const query = this.model.find(this.scopeFilter(filter, ctx));
    if (ctx.session) query.session(ctx.session);
    if (ctx.sort) query.sort(ctx.sort);
    if (ctx.skip) query.skip(ctx.skip);
    if (ctx.limit) query.limit(ctx.limit);
    return this.applyRestricted(query, ctx.permissions);
  }

  count(filter, ctx = {}) {
    return this.model.countDocuments(this.scopeFilter(filter, ctx));
  }

  async paginate(filter, ctx = {}) {
    const page = Math.max(1, Number(ctx.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(ctx.limit) || 25));
    const [items, total] = await Promise.all([
      this.find(filter, { ...ctx, skip: (page - 1) * limit, limit }),
      this.count(filter, ctx),
    ]);
    return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
  }

  create(payload, ctx = {}) {
    const doc = this.tenantScoped ? { ...payload, tenantId: ctx.tenantId } : payload;
    return this.model.create(ctx.session ? [doc] : doc, ctx.session ? { session: ctx.session } : undefined)
      .then((r) => (Array.isArray(r) ? r[0] : r));
  }

  updateById(id, update, ctx = {}) {
    const query = this.model.findOneAndUpdate(
      this.scopeFilter({ _id: id }, ctx),
      update,
      { new: true, runValidators: true, session: ctx.session },
    );
    return this.applyRestricted(query, ctx.permissions);
  }

  /** Soft delete. Hard deletion is not exposed; history is the point. */
  softDeleteById(id, ctx = {}) {
    return this.model.findOneAndUpdate(
      this.scopeFilter({ _id: id }, ctx),
      { $set: { deletedAt: new Date(), deletedBy: ctx.actorId ?? null } },
      { new: true, session: ctx.session },
    );
  }
}

export default BaseRepository;
