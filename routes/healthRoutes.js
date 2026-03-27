/**
 * @module routes/healthRoutes
 * @description Health check and root endpoint routes.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const healthController = require('../controllers/healthController');

const router = Router();

router.get('/health', asyncHandler(healthController.getHealth));
router.get('/', asyncHandler(healthController.getRoot));

module.exports = router;
