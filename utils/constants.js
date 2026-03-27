/**
 * @module utils/constants
 * @description Application-wide constants. No magic numbers or strings elsewhere.
 */

/** File type identifiers */
const FILE_TYPES = Object.freeze({
  DOCX: 'docx',
  PDF_DIGITAL: 'pdf_digital',
  PDF_SCANNED: 'pdf_scanned',
  IMAGE: 'image',
  UNKNOWN: 'unknown',
});

/** Supported file extensions grouped by type */
const SUPPORTED_EXTENSIONS = Object.freeze({
  DOCX: new Set(['.docx', '.doc']),
  PDF: new Set(['.pdf']),
  IMAGE: new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.webp']),
});

/** All supported extensions combined */
const ALL_SUPPORTED_EXTENSIONS = new Set([
  ...SUPPORTED_EXTENSIONS.DOCX,
  ...SUPPORTED_EXTENSIONS.PDF,
  ...SUPPORTED_EXTENSIONS.IMAGE,
]);

/** Minimum characters per page to classify PDF as digital (not scanned) */
const MIN_CHARS_PER_PAGE = 50;

/** Maximum pages to check when detecting PDF type */
const MAX_PAGES_TO_CHECK = 5;

/** Percentage of pages that must have text to be classified as digital */
const DIGITAL_PDF_PAGE_THRESHOLD = 0.5;

/** RRF constant for Reciprocal Rank Fusion */
const RRF_K = 60;

/** Maximum chat history messages to include in context */
const MAX_CHAT_HISTORY = 6;

/** Maximum concurrent embedding API requests */
const CONCURRENT_EMBED_LIMIT = 3;

/** Maximum snippet length for search results */
const SNIPPET_MAX_LENGTH = 200;

/** Retry configuration for external API calls */
const RETRY_CONFIG = Object.freeze({
  retries: 3,
  minTimeout: 2000,
  maxTimeout: 30000,
  factor: 2,
});

/** Confidence thresholds */
const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH: 0.80,
  MEDIUM: 0.60,
  LOW: 0.40,
});

/** Confidence scoring weights */
const CONFIDENCE_WEIGHTS = Object.freeze({
  chunkCount: 0.15,
  avgSimilarity: 0.30,
  maxSimilarity: 0.20,
  sourceDiversity: 0.10,
  sectionCoverage: 0.05,
  citationCheck: 0.20,
});

/** Section boost amount for reranking */
const SECTION_BOOST = 0.05;

/** Keyword match boost per word for reranking */
const KEYWORD_BOOST = 0.02;

/** Minimum keyword length to count for matching */
const MIN_KEYWORD_LENGTH = 3;

/** Short chunk penalty thresholds */
const SHORT_CHUNK_THRESHOLDS = Object.freeze({
  VERY_SHORT: 50,
  SHORT: 100,
  VERY_SHORT_PENALTY: 0.5,
  SHORT_PENALTY: 0.8,
});

/** Metadata richness bonus */
const METADATA_BONUS = 0.01;

/** Legal section detection patterns (case-insensitive) */
const SECTION_PATTERNS = Object.freeze([
  { pattern: /\b(?:facts|factual\s+background|statement\s+of\s+facts)\b/i, section: 'facts' },
  { pattern: /\b(?:arguments?|submissions?|contentions?)\b/i, section: 'arguments' },
  { pattern: /\b(?:order|directions?|operative\s+part)\b/i, section: 'order' },
  { pattern: /\b(?:relief|prayer|remedies)\b/i, section: 'relief' },
  { pattern: /\b(?:issues?|questions?\s+of\s+law)\b/i, section: 'issues' },
  { pattern: /\b(?:evidence|exhibits?|testimony)\b/i, section: 'evidence' },
  { pattern: /\b(?:conclusion|summary|finding)\b/i, section: 'conclusion' },
  { pattern: /\b(?:introduction|preliminary|overview)\b/i, section: 'introduction' },
  { pattern: /\b(?:background|history)\b/i, section: 'background' },
  { pattern: /\b(?:analysis|discussion|reasoning)\b/i, section: 'analysis' },
]);

/** Section keywords for query matching during reranking */
const SECTION_KEYWORDS = Object.freeze({
  facts: ['fact', 'incident', 'event', 'occurred', 'happened'],
  arguments: ['argue', 'argument', 'submit', 'contend', 'defense', 'prosecution'],
  order: ['order', 'direct', 'decree', 'judgment', 'ruling'],
  relief: ['relief', 'prayer', 'remedy', 'seek', 'grant'],
  evidence: ['evidence', 'exhibit', 'witness', 'testimony', 'prove'],
  conclusion: ['conclude', 'find', 'hold', 'determine'],
});

/** Document type detection patterns from file name */
const DOCUMENT_TYPE_PATTERNS = Object.freeze([
  { pattern: /draft/i, type: 'draft' },
  { pattern: /court.?order|order/i, type: 'court_order' },
  { pattern: /hearing/i, type: 'hearing' },
  { pattern: /evidence/i, type: 'evidence' },
  { pattern: /brief/i, type: 'brief' },
  { pattern: /petition/i, type: 'petition' },
  { pattern: /affidavit/i, type: 'affidavit' },
  { pattern: /judgment|judgement/i, type: 'judgment' },
  { pattern: /notice/i, type: 'notice' },
  { pattern: /filing/i, type: 'filing' },
  { pattern: /response|reply/i, type: 'response' },
  { pattern: /appeal/i, type: 'appeal' },
  { pattern: /motion/i, type: 'motion' },
  { pattern: /memo/i, type: 'memorandum' },
  { pattern: /contract|agreement/i, type: 'contract' },
  { pattern: /letter|correspondence/i, type: 'correspondence' },
]);

/** OCR artifact patterns to remove */
const OCR_ARTIFACT_PATTERNS = [
  /\|{2,}/g,
  /_{5,}/g,
  /={5,}/g,
  /~{5,}/g,
  /\f/g,
  /\0/g,
];

/** Header/footer patterns to remove */
const HEADER_FOOTER_PATTERNS = [
  /page\s+\d+\s+of\s+\d+/gi,
  /^\s*-\s*\d+\s*-\s*$/gm,
  /^\s*confidential\s*$/gim,
  /^\s*privileged\s*$/gim,
];

/** Hallucination indicator phrases */
const HALLUCINATION_PHRASES = [
  'as is well known',
  'generally speaking',
  'in my experience',
  'it is common knowledge',
  'as everyone knows',
  'typically in such cases',
];

/** Phrases indicating no data was found */
const NO_DATA_PHRASES = [
  'could not find',
  'no relevant',
  'not found in',
  'unable to locate',
  'no information available',
  'no data found',
];

/** HTTP status codes used in the application */
const HTTP_STATUS = Object.freeze({
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  INTERNAL_ERROR: 500,
  BAD_GATEWAY: 502,
});

/** Maximum file upload size in bytes (50MB) */
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

module.exports = {
  FILE_TYPES,
  SUPPORTED_EXTENSIONS,
  ALL_SUPPORTED_EXTENSIONS,
  MIN_CHARS_PER_PAGE,
  MAX_PAGES_TO_CHECK,
  DIGITAL_PDF_PAGE_THRESHOLD,
  RRF_K,
  MAX_CHAT_HISTORY,
  CONCURRENT_EMBED_LIMIT,
  SNIPPET_MAX_LENGTH,
  RETRY_CONFIG,
  CONFIDENCE_THRESHOLDS,
  CONFIDENCE_WEIGHTS,
  SECTION_BOOST,
  KEYWORD_BOOST,
  MIN_KEYWORD_LENGTH,
  SHORT_CHUNK_THRESHOLDS,
  METADATA_BONUS,
  SECTION_PATTERNS,
  SECTION_KEYWORDS,
  DOCUMENT_TYPE_PATTERNS,
  OCR_ARTIFACT_PATTERNS,
  HEADER_FOOTER_PATTERNS,
  HALLUCINATION_PHRASES,
  NO_DATA_PHRASES,
  HTTP_STATUS,
  MAX_UPLOAD_SIZE,
};
