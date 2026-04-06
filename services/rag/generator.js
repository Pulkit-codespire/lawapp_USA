/**
 * @module services/rag/generator
 * @description Answer generation using OpenAI or Google Gemini with legal system prompt.
 */

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../config');
const logger = require('../../config/logger');
const { NO_DATA_PHRASES, MAX_CHAT_HISTORY } = require('../../utils/constants');
const { ExternalServiceError } = require('../../utils/errors');
const { trackUsage } = require('../usageTracker');

const openai = new OpenAI({ apiKey: config.openai.apiKey });
const geminiClient = config.gemini?.apiKey
  ? new GoogleGenerativeAI(config.gemini.apiKey)
  : null;

/**
 * Check if a model name belongs to Gemini.
 * @param {string} model
 * @returns {boolean}
 */
function _isGeminiModel(model) {
  return model.startsWith('gemini');
}

/** Legal system prompt enforcing grounded answers */
const LEGAL_SYSTEM_PROMPT = `You are a legal research assistant. You help lawyers find information from their case files.

TONE: Be direct, professional, and concise. Do NOT use enthusiastic language like "Excellent!", "Great question!" — just provide the information.

CRITICAL RULES:
1. ONLY answer based on the provided document excerpts below.
2. If the documents don't contain information DIRECTLY RELEVANT to the user's question, say "I could not find this information in your case files." Do NOT present unrelated document content.
3. NEVER use your general knowledge to answer legal questions.
4. NEVER fabricate case names, section numbers, dates, or rulings.
5. Every claim MUST have a source citation in this format: 📄 [FileName] — Page X, Section Y
6. If you are unsure, recommend the lawyer verify in the original document.
7. This is a research tool, NOT legal advice. Always remind the user of this when relevant.
8. IMPORTANT: If the document excerpts are about a completely DIFFERENT topic than the user's question, do NOT summarize or present those documents. Simply state that no relevant information was found and suggest the user rephrase or upload relevant documents.`;

/**
 * @typedef {Object} GeneratedAnswer
 * @property {string} answer
 * @property {Array} sources
 * @property {string} confidence
 * @property {number} confidenceScore
 * @property {number} tokensUsed
 * @property {string} model
 */

/**
 * Generate an answer from retrieved chunks using GPT-4o.
 * @param {string} query - User's question
 * @param {Array} chunks - Retrieved and reranked chunks
 * @param {Array} [chatHistory=[]] - Previous conversation messages
 * @returns {Promise<GeneratedAnswer>}
 */
async function generate(query, chunks, chatHistory = [], aiOverrides = {}) {
  const context = _buildContext(chunks);
  const messages = _buildMessages(query, context, chatHistory);

  const model = aiOverrides.model || config.chat.model;
  const maxTokens = aiOverrides.maxTokens || config.chat.maxTokens;
  const temperature = aiOverrides.temperature !== undefined ? aiOverrides.temperature : config.chat.temperature;

  const { answer, tokensUsed, inputTok, outputTok, usedModel } = await _callLLMWithFallback(model, messages, maxTokens, temperature);

    /* Track usage (fire-and-forget) */
    trackUsage({
      operation: 'chat',
      model: usedModel,
      inputTokens: inputTok,
      outputTokens: outputTok,
      totalTokens: tokensUsed,
      metadata: { chunksUsed: chunks.length },
    });

    const sources = _extractSources(chunks);
    const { confidence, confidenceScore } = _assessConfidence(chunks, answer);

    logger.info(`Generated answer: ${answer.length} chars, ${tokensUsed} tokens, model: ${usedModel}, confidence: ${confidence}`);

    return {
      answer,
      sources,
      confidence,
      confidenceScore,
      tokensUsed,
      model: usedModel,
    };
}

/**
 * Call Gemini LLM with automatic retry using a fallback Gemini model if the primary fails.
 * @param {string} model - Primary Gemini model
 * @param {Array} messages - Chat messages
 * @param {number} maxTokens
 * @param {number} temperature
 * @returns {Promise<{answer: string, tokensUsed: number, inputTok: number, outputTok: number, usedModel: string}>}
 * @private
 */
async function _callLLMWithFallback(model, messages, maxTokens, temperature) {
  if (!geminiClient) {
    throw new ExternalServiceError('GEMINI_API_KEY is not configured. Add it to your .env file.');
  }

  /* Ensure we're using a Gemini model */
  const primaryModel = _isGeminiModel(model) ? model : 'gemini-2.5-flash';

  /* Try primary Gemini model */
  try {
    const { answer, tokensUsed } = await _generateWithGemini(primaryModel, messages, maxTokens, temperature);
    return { answer, tokensUsed, inputTok: Math.round(tokensUsed * 0.7), outputTok: tokensUsed - Math.round(tokensUsed * 0.7), usedModel: primaryModel };
  } catch (primaryErr) {
    logger.warn(`Primary Gemini model (${primaryModel}) failed: ${primaryErr.message}`);

    /* Fallback: try a different Gemini model */
    const fallbackModel = primaryModel === 'gemini-2.5-flash' ? 'gemini-1.5-flash' : 'gemini-2.5-flash';
    try {
      logger.info(`Retrying with fallback Gemini model (${fallbackModel})...`);
      const { answer, tokensUsed } = await _generateWithGemini(fallbackModel, messages, maxTokens, temperature);
      return { answer, tokensUsed, inputTok: Math.round(tokensUsed * 0.7), outputTok: tokensUsed - Math.round(tokensUsed * 0.7), usedModel: fallbackModel };
    } catch (fallbackErr) {
      logger.error(`Fallback Gemini model (${fallbackModel}) also failed: ${fallbackErr.message}`);
      throw new ExternalServiceError(`Both Gemini models failed. Primary (${primaryModel}): ${primaryErr.message}. Fallback (${fallbackModel}): ${fallbackErr.message}`);
    }
  }
}

/**
 * Build context string from retrieved chunks.
 * @param {Array} chunks
 * @returns {string}
 * @private
 */
function _buildContext(chunks) {
  return chunks.map((chunk, idx) => {
    const source = `[Source ${idx + 1}: ${chunk.fileName}, Page ${chunk.pageNumber || 'N/A'}, Section: ${chunk.section}]`;
    return `${source}\n${chunk.text}`;
  }).join('\n\n---\n\n');
}

/**
 * Build messages array for OpenAI API.
 * @param {string} query
 * @param {string} context
 * @param {Array} chatHistory
 * @returns {Array}
 * @private
 */
function _buildMessages(query, context, chatHistory) {
  const messages = [{ role: 'system', content: LEGAL_SYSTEM_PROMPT }];

  const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  const userMessage = context.length > 0
    ? `Based on the following document excerpts:\n\n${context}\n\nQuestion: ${query}`
    : `Question: ${query}\n\n(No relevant documents were found for this query.)`;

  messages.push({ role: 'user', content: userMessage });
  return messages;
}

/**
 * Extract unique source references from chunks.
 * @param {Array} chunks
 * @returns {Array}
 * @private
 */
function _extractSources(chunks) {
  const seen = new Set();

  return chunks
    .filter((chunk) => {
      const key = `${chunk.fileName}:${chunk.pageNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((chunk) => ({
      file_name: chunk.fileName,
      case_name: chunk.caseName,
      page_number: chunk.pageNumber,
      section: chunk.section,
      document_type: chunk.documentType,
      relevance_score: Math.min(1.0, Math.round(chunk.similarity * 100) / 100),
      snippet: chunk.text.slice(0, 200),
    }));
}

/**
 * Assess confidence level based on chunk quality and answer content.
 * @param {Array} chunks
 * @param {string} answer
 * @returns {{confidence: string, confidenceScore: number}}
 * @private
 */
function _assessConfidence(chunks, answer) {
  const lowerAnswer = answer.toLowerCase();
  const hasNoDataPhrase = NO_DATA_PHRASES.some((phrase) => lowerAnswer.includes(phrase));

  if (hasNoDataPhrase) {
    return { confidence: 'low', confidenceScore: 0.2 };
  }

  const avgSimilarity = chunks.length > 0
    ? chunks.reduce((sum, c) => sum + c.similarity, 0) / chunks.length
    : 0;

  const HIGH_SIM = 0.85;
  const MED_SIM = 0.75;
  const LOW_SIM = 0.65;
  const MIN_HIGH_CHUNKS = 3;
  const MIN_MED_CHUNKS = 2;

  if (avgSimilarity > HIGH_SIM && chunks.length >= MIN_HIGH_CHUNKS) {
    return { confidence: 'high', confidenceScore: Math.min(avgSimilarity, 0.95) };
  }
  if (avgSimilarity > MED_SIM && chunks.length >= MIN_MED_CHUNKS) {
    return { confidence: 'medium', confidenceScore: avgSimilarity };
  }
  if (avgSimilarity > LOW_SIM) {
    return { confidence: 'low', confidenceScore: avgSimilarity };
  }

  return { confidence: 'low', confidenceScore: Math.max(avgSimilarity, 0.1) };
}

/**
 * General knowledge system prompt — used when no case files are found.
 * Clearly states the answer is NOT from the user's documents.
 */
const GENERAL_SYSTEM_PROMPT = `You are a legal research assistant with general legal knowledge.

IMPORTANT CONTEXT:
- The user's case files database has NO matching documents for this query.
- You are answering from GENERAL legal knowledge, NOT from the user's case files.
- Always start your answer with: "⚠️ No matching case files found. Here is general legal guidance:"
- Provide helpful, accurate legal information.
- Remind the user this is general knowledge and NOT specific legal advice.
- Suggest they upload relevant case files for more specific answers.`;

/**
 * Generate an answer from OpenAI general knowledge (no documents).
 * @param {string} query - User's question
 * @param {Array} [chatHistory=[]] - Previous conversation messages
 * @returns {Promise<GeneratedAnswer>}
 */
async function generateGeneral(query, chatHistory = [], aiOverrides = {}) {
  const messages = [{ role: 'system', content: GENERAL_SYSTEM_PROMPT }];

  const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: query });

  const model = aiOverrides.model || config.chat.model;
  const maxTokens = aiOverrides.maxTokens || config.chat.maxTokens;
  const temperature = aiOverrides.temperature !== undefined ? aiOverrides.temperature : config.chat.temperature;

  const { answer, tokensUsed, inputTok, outputTok, usedModel } = await _callLLMWithFallback(model, messages, maxTokens, temperature);

    trackUsage({
      operation: 'chat',
      model: usedModel,
      inputTokens: inputTok,
      outputTokens: outputTok,
      totalTokens: tokensUsed,
      metadata: { type: 'general' },
    });

    logger.info(`General answer: ${answer.length} chars, ${tokensUsed} tokens, model: ${usedModel}`);

    return {
      answer,
      sources: [],
      confidence: 'general',
      confidenceScore: 0,
      tokensUsed,
      model: usedModel,
    };
}

/**
 * Generate an answer using Google Gemini API.
 * Converts OpenAI-style messages array to Gemini format.
 * @param {string} model - Gemini model name
 * @param {Array} messages - OpenAI-style messages array
 * @param {number} maxTokens
 * @param {number} temperature
 * @returns {Promise<{answer: string, tokensUsed: number}>}
 * @private
 */
async function _generateWithGemini(model, messages, maxTokens, temperature) {
  if (!geminiClient) {
    throw new ExternalServiceError('GEMINI_API_KEY is not configured. Add it to your .env file.');
  }

  /* Separate system prompt from conversation */
  const systemMsg = messages.find((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');

  /* Gemini 2.5 models use "thinking" tokens that consume maxOutputTokens.
     Increase output budget so thinking doesn't eat the entire response. */
  const is25Model = model.includes('2.5');
  const effectiveMaxTokens = is25Model ? Math.max(maxTokens * 4, 8192) : maxTokens;

  const geminiModel = geminiClient.getGenerativeModel({
    model,
    systemInstruction: systemMsg?.content || '',
    generationConfig: {
      maxOutputTokens: effectiveMaxTokens,
      temperature,
      ...(is25Model ? { thinkingConfig: { thinkingBudget: 2048 } } : {}),
    },
  });

  /* Convert OpenAI message format to Gemini history format */
  let history = conversation.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  /* Gemini requires first message to be 'user' — drop leading model messages */
  while (history.length > 0 && history[0].role === 'model') {
    history.shift();
  }

  /* Gemini requires alternating user/model — merge consecutive same-role messages */
  history = history.reduce((acc, msg) => {
    if (acc.length > 0 && acc[acc.length - 1].role === msg.role) {
      acc[acc.length - 1].parts[0].text += '\n\n' + msg.parts[0].text;
    } else {
      acc.push(msg);
    }
    return acc;
  }, []);

  const lastMessage = conversation[conversation.length - 1]?.content || '';

  const chat = geminiModel.startChat({ history });
  const result = await chat.sendMessage(lastMessage);

  /* Check for safety-blocked or empty responses */
  const candidates = result.response.candidates || [];
  const blockReason = candidates[0]?.finishReason;
  const answer = result.response.text() || '';
  const tokensUsed = result.response.usageMetadata?.totalTokenCount || 0;

  if (!answer || answer.trim().length === 0) {
    logger.warn(`Gemini returned empty response (finishReason: ${blockReason || 'unknown'}). Falling back to OpenAI.`);
    throw new Error(`Gemini returned empty response (blocked or safety filter, reason: ${blockReason || 'unknown'})`);
  }

  return { answer, tokensUsed };
}

/* ══════════════════════════════════════════════════════════
   UK LAW LEGAL ADVISOR — route-specific prompts & generators
   ══════════════════════════════════════════════════════════ */

/**
 * UK Legal Advisor system prompt — for strategy and tactical advice.
 * No case documents provided; answers from UK law knowledge.
 */
const UK_LEGAL_ADVISOR_PROMPT = `You are an expert UK legal advisor and litigation strategist. You provide clear, professional legal guidance to qualified lawyers based on UK law.

TONE: Be direct, professional, and authoritative. Do NOT use enthusiastic language like "Excellent!", "Great question!", "Let's build..." — just provide the legal analysis straightforwardly.

IMPORTANT RULES:
1. ALL advice must be based on UK law — English & Welsh jurisdiction unless specified otherwise.
2. Cite specific UK statutes, Acts of Parliament, and sections (e.g., "Section 18 of the Offences Against the Person Act 1861").
3. Reference relevant case law precedents where applicable (e.g., "R v Woollin [1999] 1 AC 82").
4. Reference procedural rules: CPR (Civil Procedure Rules), CrimPR (Criminal Procedure Rules), Family Procedure Rules as applicable.
5. Provide actionable, step-by-step strategic advice.
6. Consider both prosecution AND defence perspectives.
7. Mention relevant time limits, limitation periods, and procedural deadlines.
8. Flag any risks or weaknesses in the suggested approach.
9. This is professional legal guidance for qualified lawyers — be specific and technical.
10. Always end with a reminder that this is AI-assisted guidance and final decisions should be made by the instructed lawyer.

STRUCTURE your advice as:
- **Applicable Law**: Key statutes and sections
- **Relevant Precedent**: Case law that supports the position
- **Strategic Advice**: Step-by-step recommendation
- **Risks & Considerations**: Potential weaknesses or counter-arguments
- **Next Steps**: Immediate actions to take`;

/**
 * Hybrid prompt — combines case documents with UK law knowledge.
 */
const UK_HYBRID_PROMPT = `You are an expert UK legal research assistant with deep knowledge of UK law. You help lawyers by combining their case file evidence with applicable UK law.

TONE: Be direct, professional, and authoritative. Do NOT use enthusiastic language like "Excellent!", "Great question!", "Let's build..." — just provide the legal analysis straightforwardly.

CRITICAL RULES:
1. Use the provided document excerpts for CASE-SPECIFIC FACTS and evidence.
2. Apply UK law knowledge to analyse those facts — cite specific statutes, sections, and case law.
3. Every factual claim from documents MUST have a citation: 📄 [FileName] — Page X, Section Y
4. Legal principles should cite the statute or case: e.g., "Under Section 3 of the Criminal Law Act 1967..." or "Per R v Ghosh [1982] QB 1053..."
5. Connect the case facts to the legal framework — explain HOW the law applies to their specific situation.
6. Consider procedural rules (CPR, CrimPR) and any applicable time limits.
7. Provide strategic insights: strengths, weaknesses, and recommended actions.
8. If the documents don't contain relevant facts, say so — but still provide the legal framework.
9. This is for qualified UK lawyers — be precise and technical.
10. Remind the user this is AI-assisted analysis and should be verified.

STRUCTURE your analysis as:
- **Case Facts** (from documents, with citations)
- **Applicable UK Law** (statutes, sections, case law)
- **Legal Analysis** (how the law applies to these facts)
- **Strategic Recommendation** (what to do next)
- **Risks** (potential counter-arguments or weaknesses)`;

/**
 * General UK law prompt — for pure law questions without case context.
 */
const UK_GENERAL_PROMPT = `You are an expert UK legal knowledge assistant. You answer questions about UK law clearly and accurately.

TONE: Be direct, professional, and authoritative. Do NOT use enthusiastic language like "Excellent!", "Great question!", "Let's dive in..." — just provide the legal information straightforwardly.

IMPORTANT RULES:
1. ALL answers must be based on UK law — English & Welsh jurisdiction unless otherwise specified.
2. Cite specific statutes, Acts, and section numbers (e.g., "Section 1 of the Theft Act 1968").
3. Reference landmark case law where relevant (e.g., "Donoghue v Stevenson [1932] AC 562").
4. Explain legal concepts in a professional but clear manner.
5. Mention any recent amendments or changes you are aware of.
6. Note any differences between England & Wales, Scotland, and Northern Ireland jurisdictions if relevant.
7. Provide practical context — how this law is typically applied.
8. This is for qualified UK lawyers — you can be technical.
9. If you are unsure about a specific detail, say so rather than guessing.
10. Remind the user that laws may have changed since your knowledge cutoff and to verify current legislation on legislation.gov.uk.`;

/**
 * Generate legal strategy advice based on UK law (no documents).
 * Used when intent = 'legal_advice'
 * @param {string} query
 * @param {Array} [chatHistory=[]]
 * @param {Object} [aiOverrides={}]
 * @returns {Promise<GeneratedAnswer>}
 */
async function generateLegalAdvice(query, chatHistory = [], aiOverrides = {}) {
  const messages = [{ role: 'system', content: UK_LEGAL_ADVISOR_PROMPT }];

  const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: query });

  const model = aiOverrides.model || config.chat.model;
  const maxTokens = aiOverrides.maxTokens || config.chat.maxTokens;
  const temperature = aiOverrides.temperature !== undefined ? aiOverrides.temperature : 0.2;

  const { answer, tokensUsed, inputTok, outputTok, usedModel } = await _callLLMWithFallback(model, messages, maxTokens, temperature);

    trackUsage({
      operation: 'chat',
      model: usedModel,
      inputTokens: inputTok,
      outputTokens: outputTok,
      totalTokens: tokensUsed,
      metadata: { type: 'legal_advice' },
    });

    logger.info(`Legal advice: ${answer.length} chars, ${tokensUsed} tokens, model: ${usedModel}`);

    return {
      answer,
      sources: [],
      confidence: 'advice',
      confidenceScore: 0,
      tokensUsed,
      model: usedModel,
    };
}

/**
 * Generate a hybrid answer — case documents + UK law knowledge.
 * Used when intent = 'hybrid'
 * @param {string} query
 * @param {Array} chunks - Retrieved document chunks
 * @param {Array} [chatHistory=[]]
 * @param {Object} [aiOverrides={}]
 * @returns {Promise<GeneratedAnswer>}
 */
async function generateHybrid(query, chunks, chatHistory = [], aiOverrides = {}) {
  const context = _buildContext(chunks);
  const messages = [{ role: 'system', content: UK_HYBRID_PROMPT }];

  const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  const userMessage = context.length > 0
    ? `Based on the following case document excerpts:\n\n${context}\n\nQuestion: ${query}\n\nProvide analysis combining the case facts with applicable UK law.`
    : `Question: ${query}\n\n(No relevant case documents were found, but please provide UK legal analysis.)`;

  messages.push({ role: 'user', content: userMessage });

  const model = aiOverrides.model || config.chat.model;
  const maxTokens = aiOverrides.maxTokens || config.chat.maxTokens;
  const temperature = aiOverrides.temperature !== undefined ? aiOverrides.temperature : 0.15;

  const { answer, tokensUsed, inputTok, outputTok, usedModel } = await _callLLMWithFallback(model, messages, maxTokens, temperature);

    trackUsage({
      operation: 'chat',
      model: usedModel,
      inputTokens: inputTok,
      outputTokens: outputTok,
      totalTokens: tokensUsed,
      metadata: { type: 'hybrid', chunksUsed: chunks.length },
    });

    const sources = _extractSources(chunks);
    const { confidence, confidenceScore } = _assessConfidence(chunks, answer);

    logger.info(`Hybrid answer: ${answer.length} chars, ${tokensUsed} tokens, model: ${usedModel}, confidence: ${confidence}`);

    return {
      answer,
      sources,
      confidence,
      confidenceScore,
      tokensUsed,
      model: usedModel,
    };
}

/**
 * Generate a general UK law answer (no case documents).
 * Used when intent = 'general'
 * @param {string} query
 * @param {Array} [chatHistory=[]]
 * @param {Object} [aiOverrides={}]
 * @returns {Promise<GeneratedAnswer>}
 */
async function generateUKGeneral(query, chatHistory = [], aiOverrides = {}) {
  const messages = [{ role: 'system', content: UK_GENERAL_PROMPT }];

  const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: query });

  const model = aiOverrides.model || config.chat.model;
  const maxTokens = aiOverrides.maxTokens || config.chat.maxTokens;
  const temperature = aiOverrides.temperature !== undefined ? aiOverrides.temperature : 0.15;

  const { answer, tokensUsed, inputTok, outputTok, usedModel } = await _callLLMWithFallback(model, messages, maxTokens, temperature);

    trackUsage({
      operation: 'chat',
      model: usedModel,
      inputTokens: inputTok,
      outputTokens: outputTok,
      totalTokens: tokensUsed,
      metadata: { type: 'uk_general' },
    });

    logger.info(`UK general answer: ${answer.length} chars, ${tokensUsed} tokens, model: ${usedModel}`);

    return {
      answer,
      sources: [],
      confidence: 'general',
      confidenceScore: 0,
      tokensUsed,
      model: usedModel,
    };
}

module.exports = { generate, generateGeneral, generateLegalAdvice, generateHybrid, generateUKGeneral };
