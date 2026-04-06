/**
 * @module services/usageTracker
 * @description Logs AI API usage and estimates costs.
 * Pricing is approximate and based on published rates (may change).
 */

const logger = require('../config/logger');

/**
 * Approximate pricing per 1M tokens (USD).
 * Update these as providers change pricing.
 */
const PRICING = {
  // OpenAI Chat
  'gpt-4o':           { input: 2.50, output: 10.00 },
  'gpt-4o-mini':      { input: 0.15, output: 0.60 },
  'gpt-4-turbo':      { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo':    { input: 0.50, output: 1.50 },
  // OpenAI Embedding
  'text-embedding-3-small':  { input: 0.02, output: 0 },
  'text-embedding-3-large':  { input: 0.13, output: 0 },
  'text-embedding-ada-002':  { input: 0.10, output: 0 },
  // Gemini (free tier, but log for tracking)
  'gemini-2.5-pro':         { input: 1.25, output: 10.00 },
  'gemini-2.5-flash':       { input: 0, output: 0 },
  'gemini-2.0-flash':       { input: 0, output: 0 },
  'gemini-1.5-flash':       { input: 0, output: 0 },
  'gemini-1.5-pro':         { input: 1.25, output: 5.00 },
  'gemini-pro':             { input: 0, output: 0 },
  'embedding-001':          { input: 0, output: 0 },
  'text-embedding-004':     { input: 0, output: 0 },
};

/**
 * Estimate cost for a given model and token counts.
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} Estimated cost in USD
 */
function _estimateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return ((inputTokens * pricing.input) + (outputTokens * pricing.output)) / 1_000_000;
}

/**
 * Determine provider from model name.
 * @param {string} model
 * @returns {string}
 */
function _getProvider(model) {
  if (model.startsWith('gemini') || model.includes('embedding-0') || model.includes('text-embedding-004')) {
    return 'gemini';
  }
  return 'openai';
}

/**
 * Log an AI API usage event. Fire-and-forget — never throws.
 * @param {Object} params
 * @param {string} params.operation - 'chat' | 'embedding' | 're-embed'
 * @param {string} params.model
 * @param {number} [params.inputTokens=0]
 * @param {number} [params.outputTokens=0]
 * @param {number} [params.totalTokens=0]
 * @param {Object} [params.metadata={}]
 */
async function trackUsage({ operation, model, inputTokens = 0, outputTokens = 0, totalTokens = 0, metadata = {} }) {
  try {
    const { UsageLog } = require('../models');
    const provider = _getProvider(model);
    const cost = _estimateCost(model, inputTokens, outputTokens);
    const total = totalTokens || (inputTokens + outputTokens);

    await UsageLog.create({
      operation,
      provider,
      model,
      inputTokens,
      outputTokens,
      totalTokens: total,
      cost,
      metadata,
    });

    logger.debug(`Usage tracked: ${operation} ${model} — ${total} tokens, $${cost.toFixed(6)}`);
  } catch (err) {
    logger.warn(`Failed to track usage: ${err.message}`);
  }
}

module.exports = { trackUsage, PRICING };
