/**
 * @module validators/searchValidator
 * @description Validation rules for search endpoints.
 */

const { query } = require('express-validator');

const MIN_QUERY_LENGTH = 2;
const MAX_TOP_K = 50;
const MAX_LIMIT = 200;

/** Validation for GET /search */
const searchValidation = [
  query('q')
    .isString().withMessage('Query must be a string')
    .trim()
    .notEmpty().withMessage('Search query is required')
    .isLength({ min: MIN_QUERY_LENGTH })
    .withMessage(`Query must be at least ${MIN_QUERY_LENGTH} characters`),

  query('case_name')
    .optional()
    .isString()
    .trim(),

  query('document_type')
    .optional()
    .isString()
    .trim(),

  query('top_k')
    .optional()
    .isInt({ min: 1, max: MAX_TOP_K })
    .withMessage(`top_k must be 1-${MAX_TOP_K}`)
    .toInt(),
];

/** Validation for GET /search/documents */
const documentsValidation = [
  query('case_name').optional().isString().trim(),
  query('file_type').optional().isString().trim(),
  query('skip').optional().isInt({ min: 0 }).withMessage('skip must be >= 0').toInt(),
  query('limit').optional().isInt({ min: 1, max: MAX_LIMIT }).withMessage(`limit must be 1-${MAX_LIMIT}`).toInt(),
];

module.exports = { searchValidation, documentsValidation };
