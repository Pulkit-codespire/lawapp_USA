/**
 * @module utils/errors
 * @description Custom error classes for structured error handling.
 */

const { HTTP_STATUS } = require('./constants');

/**
 * Base application error with HTTP status code.
 */
class AppError extends Error {
  /**
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code
   * @param {boolean} [isOperational=true] - Whether this is an expected error
   */
  constructor(message, statusCode, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** 400 — Bad request / validation error */
class ValidationError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, HTTP_STATUS.BAD_REQUEST);
  }
}

/** 404 — Resource not found */
class NotFoundError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, HTTP_STATUS.NOT_FOUND);
  }
}

/** 422 — Document extraction or processing failure */
class ExtractionError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, HTTP_STATUS.UNPROCESSABLE);
  }
}

/** 500 — Internal database error */
class DatabaseError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, HTTP_STATUS.INTERNAL_ERROR, false);
  }
}

/** 502 — External service failure (OpenAI, etc.) */
class ExternalServiceError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, HTTP_STATUS.BAD_GATEWAY);
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ExtractionError,
  DatabaseError,
  ExternalServiceError,
};
