/**
 * @module middlewares/notFound
 * @description 404 handler for unmatched routes.
 */

const { HTTP_STATUS } = require('../utils/constants');

/**
 * Respond with 404 for any unmatched route.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function notFound(req, res) {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    error: 'Not Found',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    path: req.originalUrl,
  });
}

module.exports = notFound;
