/**
 * @module utils/asyncHandler
 * @description Wraps async Express route handlers to catch errors automatically.
 * Eliminates try/catch blocks in every controller method.
 */

/**
 * Wrap an async route handler to forward errors to Express error middleware.
 * @param {Function} fn - Async route handler (req, res, next) => Promise
 * @returns {Function} Express middleware
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
