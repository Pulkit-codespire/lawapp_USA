/**
 * @module app
 * @description Express application factory.
 * Creates and configures the Express app with all middleware and routes.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { registerRoutes } = require('./routes');
const requestLogger = require('./middlewares/requestLogger');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

/** Request body size limit */
const BODY_SIZE_LIMIT = '10mb';

/**
 * Create and configure the Express application.
 * @returns {import('express').Application}
 */
function createApp() {
  const app = express();

  /* Security headers */
  app.use(helmet());

  /* CORS — allow all origins in development */
  app.use(cors({
    origin: process.env.NODE_ENV === 'production'
      ? process.env.CORS_ORIGIN || 'http://localhost:3000'
      : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  /* Body parsing */
  app.use(express.json({ limit: BODY_SIZE_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));

  /* Request logging */
  app.use(requestLogger);

  /* Routes */
  registerRoutes(app);

  /* 404 handler */
  app.use(notFound);

  /* Centralized error handler (must be last) */
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
