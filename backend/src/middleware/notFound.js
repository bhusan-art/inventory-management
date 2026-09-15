import { NotFoundError } from '../utils/errors.js';

export function notFound(req, _res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} does not exist`, 'ROUTE_NOT_FOUND'));
}

export default notFound;
