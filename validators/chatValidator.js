/**
 * @module validators/chatValidator
 * @description Validation rules for POST /chat endpoint.
 */

const { body } = require('express-validator');

const MAX_QUESTION_LENGTH = 5000;
const MIN_QUESTION_LENGTH = 2;
const MAX_SESSION_LENGTH = 100;

/** Validation chain for chat requests */
const chatValidation = [
  body('question')
    .isString().withMessage('Question must be a string')
    .trim()
    .notEmpty().withMessage('Question is required')
    .isLength({ min: MIN_QUESTION_LENGTH, max: MAX_QUESTION_LENGTH })
    .withMessage(`Question must be ${MIN_QUESTION_LENGTH}-${MAX_QUESTION_LENGTH} characters`),

  body('session_id')
    .optional()
    .isString().withMessage('Session ID must be a string')
    .isLength({ max: MAX_SESSION_LENGTH })
    .withMessage(`Session ID must be under ${MAX_SESSION_LENGTH} characters`),

  body('case_name')
    .optional()
    .isString().withMessage('Case name must be a string')
    .trim(),

  body('document_type')
    .optional()
    .isString().withMessage('Document type must be a string')
    .trim(),
];

module.exports = { chatValidation };
