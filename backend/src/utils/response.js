/** Response envelope, per the API contract. Used by every controller. */
export function ok(res, { data = null, message = 'OK', meta, status = 200 } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function created(res, { data, message = 'Created' } = {}) {
  return ok(res, { data, message, status: 201 });
}

export function fail(res, { message, errors = [], status = 400 }) {
  return res.status(status).json({ success: false, message, errors });
}
