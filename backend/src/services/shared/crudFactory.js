import { BaseRepository } from '../../repositories/baseRepository.js';
import { writeAudit, diff } from './auditService.js';
import { assertNotReferenced } from './referenceGuard.js';
import { NotFoundError, ConflictError, DomainError } from '../../utils/errors.js';
import { parseSort } from '../../validators/common.schema.js';

/**
 * Master-data CRUD.
 *
 * Eight collections with the same lifecycle: list with search and pagination,
 * read, create, update, soft delete with reference checking, and an audit
 * entry for every mutation. Written once.
 *
 * The value is not the saved keystrokes — it is that a rule fixed here is
 * fixed everywhere. When Phase 3 adds a reference from GRN to Vendor, no
 * vendor-specific delete code needs to learn about it.
 *
 * Entity services wrap the returned object and override only what differs
 * (see productService).
 */
export function createCrudService({
  model,
  modelName,
  auditModule = modelName,
  uniqueFields = [],
  searchFields = [],
  defaultSort = { createdAt: -1 },
  populate = [],
  auditFields = [],
  beforeCreate,
  beforeUpdate,
  beforeDelete,
}) {
  const repository = new BaseRepository(model, { tenantScoped: true, softDelete: true });

  async function assertUnique(payload, { tenantId, excludeId } = {}) {
    for (const field of uniqueFields) {
      const value = payload[field];
      if (value === undefined || value === null || value === '') continue;

      const filter = { tenantId, [field]: value, deletedAt: null };
      if (excludeId) filter._id = { $ne: excludeId };

      if (await model.countDocuments(filter)) {
        throw new ConflictError(
          `Another record already uses this ${field}`,
          'DUPLICATE_VALUE',
          [{ code: 'DUPLICATE_VALUE', field }],
        );
      }
    }
  }

  function buildFilter(query) {
    const filter = { ...(query.filter ?? {}) };

    if (query.search && searchFields.length > 0) {
      filter.$or = searchFields.map((f) => ({ [f]: { $regex: escapeRegex(query.search), $options: 'i' } }));
    }
    if (query.status) filter.status = query.status;

    return filter;
  }

  async function list(actor, query) {
    const result = await repository.paginate(buildFilter(query), {
      tenantId: actor.tenantId,
      permissions: actor.permissions,
      page: query.page,
      limit: query.limit,
      sort: parseSort(query.sort, defaultSort),
      includeDeleted: query.includeDeleted,
    });

    if (populate.length > 0) await model.populate(result.items, populate);
    return result;
  }

  async function getById(actor, id) {
    const query = repository.findById(id, {
      tenantId: actor.tenantId,
      permissions: actor.permissions,
    });
    const doc = populate.length > 0 ? await query.populate(populate) : await query;
    if (!doc) throw new NotFoundError(`${modelName} not found`);
    return doc;
  }

  async function create(actor, payload) {
    if (beforeCreate) await beforeCreate({ actor, payload });
    await assertUnique(payload, { tenantId: actor.tenantId });

    const doc = await model.create({
      ...payload,
      tenantId: actor.tenantId,
      createdBy: actor.id,
    });

    await writeAudit({
      action: `${auditModule.toUpperCase()}_CREATED`,
      module: modelName,
      recordId: doc._id,
      recordLabel: labelFor(doc),
      severity: 'NOTICE',
      tenantId: actor.tenantId,
    });

    return populate.length > 0 ? doc.populate(populate) : doc;
  }

  async function update(actor, id, payload) {
    const doc = await model.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
    if (!doc) throw new NotFoundError(`${modelName} not found`);

    if (beforeUpdate) await beforeUpdate({ actor, doc, payload });
    await assertUnique(payload, { tenantId: actor.tenantId, excludeId: id });

    const before = doc.toObject();
    Object.assign(doc, payload);
    doc.updatedBy = actor.id;
    await doc.save();

    await writeAudit({
      action: `${auditModule.toUpperCase()}_UPDATED`,
      module: modelName,
      recordId: doc._id,
      recordLabel: labelFor(doc),
      severity: 'NOTICE',
      tenantId: actor.tenantId,
      changes: diff(before, doc.toObject(), auditFields.length ? auditFields : Object.keys(payload)),
    });

    return populate.length > 0 ? doc.populate(populate) : doc;
  }

  async function remove(actor, id) {
    const doc = await model.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
    if (!doc) throw new NotFoundError(`${modelName} not found`);

    if (doc.isSystem) {
      throw new DomainError(`System ${modelName.toLowerCase()} records cannot be deleted`, 'SYSTEM_RECORD_PROTECTED');
    }

    if (beforeDelete) await beforeDelete({ actor, doc });
    await assertNotReferenced(modelName, doc._id, { tenantId: actor.tenantId });

    doc.deletedAt = new Date();
    doc.deletedBy = actor.id;
    await doc.save();

    await writeAudit({
      action: `${auditModule.toUpperCase()}_DELETED`,
      module: modelName,
      recordId: doc._id,
      recordLabel: labelFor(doc),
      severity: 'WARNING',
      tenantId: actor.tenantId,
    });

    return { success: true };
  }

  return { repository, model, modelName, list, getById, create, update, remove, assertUnique };
}

/** Best-effort human label for audit entries, without each caller supplying one. */
function labelFor(doc) {
  return doc.name ?? doc.vendorName ?? doc.customerName ?? doc.code ?? String(doc._id);
}

/** User-supplied search text goes into a regex — escape it or `.*` scans the collection. */
export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
