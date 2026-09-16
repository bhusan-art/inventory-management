import { deniedRestrictedFields } from '../constants/restrictedFields.js';

/**
 * Serializer — ARCHITECTURE.md §5, layer 5.
 *
 * Restricted fields the actor may not read are OMITTED, not nulled and not
 * masked. `phone: null` on a list of 500 users still tells you which 40 have a
 * phone number on file, and `phone: "***"` tells you the same thing plus the
 * fact that you are being filtered. Absence reveals nothing.
 */
export function stripRestricted(plain, modelName, permissions) {
  const denied = deniedRestrictedFields(modelName, permissions ?? new Set());
  if (denied.length === 0) return plain;

  const out = { ...plain };
  for (const path of denied) {
    const [root] = path.split('.');
    delete out[root];
  }
  return out;
}

/**
 * @param doc        Mongoose document or plain object
 * @param modelName  key into the restricted-field registry
 * @param mapper     shapes the DTO; receives a plain object
 * @param permissions Set of the actor's effective permissions
 */
export function serialize(doc, { modelName, mapper, permissions }) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const safe = stripRestricted(plain, modelName, permissions);
  return mapper ? mapper(safe) : safe;
}

export function serializeMany(docs = [], options) {
  return docs.map((d) => serialize(d, options));
}

export default serialize;
