/**
 * @module controllers/authController
 * @description Handles user registration, login, and profile.
 */

const { User } = require('../models');
const { generateToken } = require('../middlewares/auth');
const logger = require('../config/logger');
const { HTTP_STATUS } = require('../utils/constants');

/**
 * POST /auth/register — Create a new user account.
 */
async function register(req, res) {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Name, email, and password are required',
    });
  }

  if (password.length < 6) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Password must be at least 6 characters',
    });
  }

  const existing = await User.findOne({ where: { email: email.toLowerCase() } });
  if (existing) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'An account with this email already exists',
    });
  }

  const user = await User.create({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password,
  });

  const { accessToken, expiresIn } = generateToken(user);

  logger.info(`User registered: ${user.email}`);

  return res.status(HTTP_STATUS.CREATED).json({
    user: user.toSafeJSON(),
    accessToken,
    expiresIn,
  });
}

/**
 * POST /auth/login — Authenticate and return JWT.
 */
async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Email and password are required',
    });
  }

  const user = await User.findOne({ where: { email: email.toLowerCase() } });
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.isActive) {
    return res.status(401).json({ error: 'Account is deactivated' });
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  /* Update last login */
  await user.update({ lastLoginAt: new Date() });

  const { accessToken, expiresIn } = generateToken(user);

  logger.info(`User logged in: ${user.email}`);

  return res.json({
    user: user.toSafeJSON(),
    accessToken,
    expiresIn,
  });
}

/**
 * GET /auth/me — Get current user profile.
 */
async function getProfile(req, res) {
  return res.json({ user: req.user.toSafeJSON() });
}

module.exports = { register, login, getProfile };
