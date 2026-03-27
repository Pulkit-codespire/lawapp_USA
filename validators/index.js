/**
 * @module validators
 * @description Shared validation error handler for express-validator.
 */

const { validationResult } = require('express-validator');
const { HTTP_STATUS } = require('../utils/constants');

/**
 * Middleware that checks for validation errors and returns 400 if any.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Validation Error',
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
        value: e.value,
      })),
    });
  }

  return next();
}

module.exports = { handleValidationErrors };
