/**
 * @module validators/ingestValidator
 * @description Validation rules for ingestion endpoints.
 */

const { body } = require('express-validator');

/** Validation for POST /ingest/file (case_name in form data) */
const fileUploadValidation = [
  body('case_name')
    .isString().withMessage('Case name must be a string')
    .trim()
    .notEmpty().withMessage('Case name is required'),
];

/** Validation for POST /ingest/folder */
const folderIngestValidation = [
  body('folder_path')
    .isString().withMessage('Folder path must be a string')
    .trim()
    .notEmpty().withMessage('Folder path is required'),

  body('case_name')
    .optional()
    .isString().withMessage('Case name must be a string')
    .trim(),
];

module.exports = { fileUploadValidation, folderIngestValidation };
