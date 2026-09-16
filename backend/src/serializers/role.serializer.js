import { serialize, serializeMany } from './serialize.js';

const MODEL = 'Role';

const mapper = (r) => ({
  id: String(r._id),
  code: r.code,
  name: r.name,
  description: r.description ?? null,
  permissions: r.permissions ?? [],
  permissionCount: (r.permissions ?? []).length,
  rank: r.rank,
  isSystem: Boolean(r.isSystem),
  status: r.status,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export const serializeRole = (doc, permissions) => serialize(doc, { modelName: MODEL, mapper, permissions });
export const serializeRoles = (docs, permissions) => serializeMany(docs, { modelName: MODEL, mapper, permissions });
