/**
 * @module middlewares/auth
 * @description JWT authentication middleware.
 */

const jwt = require('jsonwebtoken');
const { User } = require('../models');
const logger = require('../config/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'lawapp-dev-secret-change-in-production';

/**
 * Verify JWT token and attach user to request.
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findByPk(decoded.id);

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    logger.warn(`Auth failed: ${err.message}`);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Generate JWT token for a user.
 * @param {Object} user - User instance
 * @returns {{ accessToken: string, expiresIn: number }}
 */
function generateToken(user) {
  const expiresIn = 7 * 24 * 60 * 60; // 7 days
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn }
  );
  return { accessToken, expiresIn };
}

module.exports = { authenticate, generateToken, JWT_SECRET };
