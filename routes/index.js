/**
 * @module routes
 * @description Registers all route modules on the Express app.
 */

const chatRoutes = require('./chatRoutes');
const ingestRoutes = require('./ingestRoutes');
const searchRoutes = require('./searchRoutes');
const healthRoutes = require('./healthRoutes');
const settingsRoutes = require('./settingsRoutes');

/**
 * Mount all routers on the Express app.
 * @param {import('express').Application} app
 */
function registerRoutes(app) {
  app.use(chatRoutes);
  app.use(ingestRoutes);
  app.use(searchRoutes);
  app.use(healthRoutes);
  app.use(settingsRoutes);
}

module.exports = { registerRoutes };
