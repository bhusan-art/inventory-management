/**
 * Wraps an async route handler so rejected promises reach the Express error
 * handler instead of becoming unhandled rejections.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
