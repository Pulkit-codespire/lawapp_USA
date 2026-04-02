/**
 * @module routes
 * @description Registers all route modules on the Express app.
 */

const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const chatSessionRoutes = require('./chatSessionRoutes');
const ingestRoutes = require('./ingestRoutes');
const searchRoutes = require('./searchRoutes');
const healthRoutes = require('./healthRoutes');
const settingsRoutes = require('./settingsRoutes');
const gdriveRoutes = require('./gdriveRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const { authenticate } = require('../middlewares/auth');

/**
 * Mount all routers on the Express app.
 * @param {import('express').Application} app
 */
function registerRoutes(app) {
  /* Public routes */
  app.use(authRoutes);
  app.use(healthRoutes);

  /* Protected routes — require JWT */
  app.use(authenticate);
  app.use(chatRoutes);
  app.use(chatSessionRoutes);
  app.use(ingestRoutes);
  app.use(searchRoutes);
  app.use(settingsRoutes);
  app.use(gdriveRoutes);
  app.use(dashboardRoutes);
}

module.exports = { registerRoutes };
