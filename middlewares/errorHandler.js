/**
 * @module middlewares/errorHandler
 * @description Centralized Express error handling middleware.
 */

const logger = require('../config/logger');
const { AppError } = require('../utils/errors');
const { HTTP_STATUS } = require('../utils/constants');

/**
 * Express error handler — catches all errors from controllers and services.
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  /* Log the error */
  if (err instanceof AppError && err.isOperational) {
    logger.warn(`${err.name}: ${err.message}`);
  } else {
    logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  }

  /* Sequelize validation errors */
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Validation Error',
      message: err.errors?.map((e) => e.message).join(', ') || err.message,
    });
  }

  /* Multer file size error */
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({
      error: 'File Too Large',
      message: 'Uploaded file exceeds the 50MB limit',
    });
  }

  /* Multer general errors */
  if (err.name === 'MulterError') {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Upload Error',
      message: err.message,
    });
  }

  /* Known application errors */
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
    });
  }

  /* Unknown errors */
  const isDev = process.env.NODE_ENV === 'development';
  return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
    error: 'Internal Server Error',
    message: isDev ? err.message : 'An unexpected error occurred',
    ...(isDev && { stack: err.stack }),
  });
}

module.exports = errorHandler;
