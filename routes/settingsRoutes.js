/**
 * @module routes/settingsRoutes
 * @description Settings endpoint routes — list available AI models, save/load config.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { Settings } = require('../models');
const config = require('../config');
const logger = require('../config/logger');
const reembedder = require('../services/reembedder');

const router = Router();

const AI_CONFIG_KEY = 'ai_config';

const DEFAULT_AI_CONFIG = {
  model: 'gpt-4o',
  embeddingModel: 'text-embedding-3-small',
  temperature: 0.1,
  maxTokens: 2000,
  topKResults: 10,
  similarityThreshold: 0.01,
};

/**
 * GET /settings/models
 * Fetches available models from OpenAI and Gemini APIs.
 */
router.get('/settings/models', asyncHandler(async (req, res) => {
  const providers = [];

  /* Fetch OpenAI models */
  if (config.openai.apiKey) {
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: config.openai.apiKey });
      const response = await openai.models.list();

      const chatModels = response.data
        .filter((m) => m.id.startsWith('gpt-'))
        .map((m) => m.id)
        .sort()
        .reverse();

      providers.push({
        provider: 'OpenAI',
        color: '#10a37f',
        configured: true,
        models: chatModels.map((id) => ({ value: id, label: id })),
      });
    } catch (err) {
      logger.warn(`Failed to fetch OpenAI models: ${err.message}`);
      providers.push({
        provider: 'OpenAI',
        color: '#10a37f',
        configured: false,
        error: 'Invalid API key',
        models: [],
      });
    }
  } else {
    providers.push({
      provider: 'OpenAI',
      color: '#10a37f',
      configured: false,
      error: 'No API key set',
      models: [],
    });
  }

  /* Fetch Gemini models */
  if (config.gemini.apiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${config.gemini.apiKey}`
      );
      const data = await response.json();

      if (data.models) {
        const chatModels = data.models
          .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m) => ({
            value: m.name.replace('models/', ''),
            label: m.displayName || m.name.replace('models/', ''),
            description: m.description ? m.description.substring(0, 80) : '',
          }))
          .sort((a, b) => a.label.localeCompare(b.label));

        providers.push({
          provider: 'Google Gemini',
          color: '#4285F4',
          configured: true,
          models: chatModels,
        });
      }
    } catch (err) {
      logger.warn(`Failed to fetch Gemini models: ${err.message}`);
      providers.push({
        provider: 'Google Gemini',
        color: '#4285F4',
        configured: false,
        error: 'Failed to fetch models',
        models: [],
      });
    }
  } else {
    providers.push({
      provider: 'Google Gemini',
      color: '#4285F4',
      configured: false,
      error: 'No API key set',
      models: [],
    });
  }

  /* Collect embedding models (with dimension info) */
  const embeddingModels = [];

  /* OpenAI embedding models */
  if (config.openai.apiKey) {
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: config.openai.apiKey });
      const response = await openai.models.list();

      const embedModels = response.data
        .filter((m) => m.id.includes('embedding'))
        .map((m) => m.id)
        .sort();

      embedModels.forEach((id) => {
        embeddingModels.push({
          value: id,
          label: id,
          provider: 'OpenAI',
          dimensions: reembedder.getDimensions(id),
        });
      });
    } catch (err) {
      logger.warn(`Failed to fetch OpenAI embedding models: ${err.message}`);
    }
  }

  /* Gemini embedding models */
  if (config.gemini.apiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${config.gemini.apiKey}`
      );
      const data = await response.json();

      if (data.models) {
        data.models
          .filter((m) => m.supportedGenerationMethods?.includes('embedContent'))
          .forEach((m) => {
            const modelId = m.name.replace('models/', '');
            embeddingModels.push({
              value: modelId,
              label: m.displayName || modelId,
              provider: 'Google Gemini',
              dimensions: reembedder.getDimensions(modelId),
            });
          });
      }
    } catch (err) {
      logger.warn(`Failed to fetch Gemini embedding models: ${err.message}`);
    }
  }

  res.json({ providers, embeddingModels });
}));

/**
 * GET /settings/config
 * Load saved AI configuration from database.
 */
router.get('/settings/config', asyncHandler(async (req, res) => {
  const saved = await Settings.get(AI_CONFIG_KEY, DEFAULT_AI_CONFIG);
  res.json({ config: saved });
}));

/**
 * PUT /settings/config
 * Save AI configuration to database.
 */
router.put('/settings/config', asyncHandler(async (req, res) => {
  const { model, embeddingModel, temperature, maxTokens, topKResults, similarityThreshold } = req.body;

  const newConfig = {
    model: model || DEFAULT_AI_CONFIG.model,
    embeddingModel: embeddingModel || DEFAULT_AI_CONFIG.embeddingModel,
    temperature: temperature !== undefined ? temperature : DEFAULT_AI_CONFIG.temperature,
    maxTokens: maxTokens || DEFAULT_AI_CONFIG.maxTokens,
    topKResults: topKResults || DEFAULT_AI_CONFIG.topKResults,
    similarityThreshold: similarityThreshold !== undefined ? similarityThreshold : DEFAULT_AI_CONFIG.similarityThreshold,
  };

  await Settings.set(AI_CONFIG_KEY, newConfig);
  logger.info(`AI config saved: model=${newConfig.model}, temp=${newConfig.temperature}`);

  res.json({ config: newConfig, message: 'Settings saved' });
}));

/**
 * DELETE /settings/config
 * Reset AI configuration to defaults.
 */
router.delete('/settings/config', asyncHandler(async (req, res) => {
  await Settings.set(AI_CONFIG_KEY, DEFAULT_AI_CONFIG);
  logger.info('AI config reset to defaults');
  res.json({ config: DEFAULT_AI_CONFIG, message: 'Settings reset to defaults' });
}));

/**
 * POST /settings/re-embed
 * Re-embed all chunks with the currently selected embedding model.
 * Starts in the background — poll /settings/re-embed/status for progress.
 */
router.post('/settings/re-embed', asyncHandler(async (req, res) => {
  const saved = await Settings.get(AI_CONFIG_KEY, DEFAULT_AI_CONFIG);
  const embeddingModel = saved.embeddingModel || DEFAULT_AI_CONFIG.embeddingModel;

  logger.info(`Starting re-embed with model: ${embeddingModel}`);

  /* Start re-embedding in the background (auto-detects dimensions) */
  reembedder.reembedAll(embeddingModel).catch((err) => {
    logger.error(`Background re-embed failed: ${err.message}`);
  });

  /* Small delay to let status update with detected dimensions */
  await new Promise((resolve) => setTimeout(resolve, 500));

  const status = reembedder.getStatus();

  res.json({
    message: `Re-embedding started with ${embeddingModel} (${status.targetDimensions || '?'} dimensions)`,
    model: embeddingModel,
    dimensions: status.targetDimensions,
    status,
  });
}));

/**
 * GET /settings/re-embed/status
 * Get current re-embedding progress.
 */
router.get('/settings/re-embed/status', asyncHandler(async (req, res) => {
  res.json(reembedder.getStatus());
}));

/**
 * GET /settings/embedding-info
 * Get dimension info for embedding models.
 */
router.get('/settings/embedding-info', asyncHandler(async (req, res) => {
  const saved = await Settings.get(AI_CONFIG_KEY, DEFAULT_AI_CONFIG);
  const currentModel = saved.embeddingModel || DEFAULT_AI_CONFIG.embeddingModel;
  const currentDimensions = reembedder.getDimensions(currentModel);

  /* Get actual DB column dimensions */
  let dbDimensions = null;
  try {
    const [result] = await require('../models').sequelize.query(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`
    );
    if (result.length > 0 && result[0].atttypmod > 0) {
      dbDimensions = result[0].atttypmod;
    }
  } catch {
    /* ignore */
  }

  res.json({
    currentModel,
    currentDimensions,
    dbDimensions,
    modelDimensions: reembedder.MODEL_DIMENSIONS,
  });
}));

module.exports = router;
