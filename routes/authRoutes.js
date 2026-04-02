/**
 * @module routes/authRoutes
 * @description Authentication routes — register, login, profile.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { register, login, getProfile } = require('../controllers/authController');
const { authenticate } = require('../middlewares/auth');

const router = Router();

router.post('/auth/register', asyncHandler(register));
router.post('/auth/login', asyncHandler(login));
router.get('/auth/me', authenticate, asyncHandler(getProfile));

module.exports = router;
