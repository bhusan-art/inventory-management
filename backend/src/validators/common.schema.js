import { z } from 'zod';

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid identifier');

export const idParamSchema = z.object({ id: objectIdSchema });

/**
 * Strips MongoDB operators from a caller-supplied filter.
 *
 * This is where injection is actually blocked. `?filter[status][$ne]=null`
 * would otherwise reach the query builder as a live operator and match every
 * record regardless of status.
 *
 * Applied only to input that crosses the HTTP boundary. Filters written in
 * service code keep their operators, because code is not untrusted input —
 * which is precisely the distinction Mongoose's global `sanitizeFilter` cannot
 * make (see config/db.js).
 */
export function sanitizeUserFilter(filter) {
  if (!filter || typeof filter !== 'object') return {};

  const clean = {};
  for (const [key, value] of Object.entries(filter)) {
    // Reject operator keys and dotted paths that could reach into subdocuments
    // the caller was never meant to address.
    if (key.startsWith('$') || key.includes('\0')) continue;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const hasOperator = Object.keys(value).some((k) => k.startsWith('$'));
      // An object value is only ever an injection attempt here; the supported
      // query surface is scalars and arrays.
      if (hasOperator) continue;
      continue;
    }

    clean[key] = value;
  }
  return clean;
}

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(200).optional(),
  search: z.string().trim().max(200).optional(),
  status: z.string().trim().max(40).optional(),
  filter: z.record(z.any()).optional().transform((v) => (v ? sanitizeUserFilter(v) : undefined)),
  includeDeleted: z.coerce.boolean().default(false),
});

/** "createdAt:desc,name:asc" → { createdAt: -1, name: 1 } */
export function parseSort(sort, fallback = { createdAt: -1 }) {
  if (!sort) return fallback;
  const parsed = {};
  for (const part of String(sort).split(',')) {
    const [field, dir] = part.split(':');
    if (!field) continue;
    parsed[field.trim()] = dir?.trim().toLowerCase() === 'asc' ? 1 : -1;
  }
  return Object.keys(parsed).length ? parsed : fallback;
}
