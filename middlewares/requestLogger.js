/**
 * @module middlewares/requestLogger
 * @description HTTP request logging using Morgan with Winston stream.
 */

const morgan = require('morgan');
const logger = require('../config/logger');

/** Morgan middleware configured with combined format and Winston stream */
const requestLogger = morgan('short', {
  stream: logger.stream,
  skip: (_req, res) => res.statusCode < 400 && process.env.NODE_ENV === 'production',
});

module.exports = requestLogger;
