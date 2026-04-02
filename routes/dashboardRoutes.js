/**
 * @module routes/dashboardRoutes
 * @description AI usage dashboard — stats, costs, and breakdowns.
 */

const { Router } = require('express');
const { Op, fn, col, literal } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { UsageLog, Document, Chunk, sequelize } = require('../models');
const { PRICING } = require('../services/usageTracker');

const router = Router();

/**
 * GET /dashboard/stats — Aggregate AI usage statistics.
 * Query params: ?days=30 (default 30)
 */
router.get('/dashboard/stats', asyncHandler(async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const since = new Date();
  since.setDate(since.getDate() - days);

  /* Totals */
  const [totals] = await UsageLog.findAll({
    where: { created_at: { [Op.gte]: since } },
    attributes: [
      [fn('COUNT', col('id')), 'totalCalls'],
      [fn('SUM', col('input_tokens')), 'totalInputTokens'],
      [fn('SUM', col('output_tokens')), 'totalOutputTokens'],
      [fn('SUM', col('total_tokens')), 'totalTokens'],
      [fn('SUM', col('cost')), 'totalCost'],
    ],
    raw: true,
  });

  /* By operation */
  const byOperation = await UsageLog.findAll({
    where: { created_at: { [Op.gte]: since } },
    attributes: [
      'operation',
      [fn('COUNT', col('id')), 'calls'],
      [fn('SUM', col('total_tokens')), 'tokens'],
      [fn('SUM', col('cost')), 'cost'],
    ],
    group: ['operation'],
    raw: true,
  });

  /* By model */
  const byModel = await UsageLog.findAll({
    where: { created_at: { [Op.gte]: since } },
    attributes: [
      'model',
      'provider',
      [fn('COUNT', col('id')), 'calls'],
      [fn('SUM', col('input_tokens')), 'inputTokens'],
      [fn('SUM', col('output_tokens')), 'outputTokens'],
      [fn('SUM', col('total_tokens')), 'tokens'],
      [fn('SUM', col('cost')), 'cost'],
    ],
    group: ['model', 'provider'],
    order: [[fn('SUM', col('total_tokens')), 'DESC']],
    raw: true,
  });

  /* Daily usage (for chart) */
  const daily = await sequelize.query(`
    SELECT
      DATE(created_at) as date,
      operation,
      COUNT(*)::int as calls,
      SUM(total_tokens)::int as tokens,
      ROUND(SUM(cost)::numeric, 6) as cost
    FROM usage_logs
    WHERE created_at >= :since
    GROUP BY DATE(created_at), operation
    ORDER BY date ASC
  `, {
    replacements: { since: since.toISOString() },
    type: sequelize.QueryTypes.SELECT,
  });

  /* Document & chunk counts */
  const docCount = await Document.count();
  const chunkCount = await Chunk.count();

  res.json({
    period: { days, since: since.toISOString() },
    totals: {
      apiCalls: parseInt(totals.totalCalls) || 0,
      inputTokens: parseInt(totals.totalInputTokens) || 0,
      outputTokens: parseInt(totals.totalOutputTokens) || 0,
      totalTokens: parseInt(totals.totalTokens) || 0,
      estimatedCost: parseFloat(totals.totalCost) || 0,
    },
    byOperation: byOperation.map((r) => ({
      operation: r.operation,
      calls: parseInt(r.calls),
      tokens: parseInt(r.tokens) || 0,
      cost: parseFloat(r.cost) || 0,
    })),
    byModel: byModel.map((r) => ({
      model: r.model,
      provider: r.provider,
      calls: parseInt(r.calls),
      inputTokens: parseInt(r.inputTokens) || 0,
      outputTokens: parseInt(r.outputTokens) || 0,
      tokens: parseInt(r.tokens) || 0,
      cost: parseFloat(r.cost) || 0,
    })),
    daily,
    documents: docCount,
    chunks: chunkCount,
    pricing: PRICING,
  });
}));

/**
 * GET /dashboard/recent — Recent API calls (latest 50).
 */
router.get('/dashboard/recent', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  const logs = await UsageLog.findAll({
    order: [['created_at', 'DESC']],
    limit,
    raw: true,
  });

  res.json({ logs });
}));

module.exports = router;
