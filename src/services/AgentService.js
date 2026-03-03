/**
 * AgentService — Claude Agent SDK Backend Client
 *
 * Connects to the Claude Agent SDK backend server to request
 * AI-powered interpretation of hydrocephalus morphometrics results.
 * Falls back gracefully when the server is unavailable.
 *
 * Server API endpoints:
 *   GET  /api/health    — Health check
 *   POST /api/interpret — Request AI interpretation of results
 *
 * The base URL is read from expo-constants at runtime:
 *   Constants.expoConfig?.extra?.AGENT_API_URL
 *
 * Defaults to http://localhost:3001 when not configured.
 *
 * Author: Matheus Machado Rech
 * License: Research use only — not for clinical diagnosis
 */

'use strict';

import Constants from 'expo-constants';

// ─── Server Configuration ──────────────────────────────────────────────────────

/**
 * Resolve the Agent backend base URL from expo-constants.
 * Falls back to localhost:3001 for local development.
 *
 * @returns {string} Base URL without trailing slash
 */
function getBaseUrl() {
  const url = Constants.expoConfig?.extra?.AGENT_API_URL || 'http://localhost:3001';
  return url.replace(/\/+$/, '');
}

// ─── Health Check ──────────────────────────────────────────────────────────────

/**
 * Check if the Agent backend server is reachable and healthy.
 * Uses a 5-second timeout to avoid blocking the UI.
 *
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
export async function checkAgentHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(`${getBaseUrl()}/api/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      return {
        available: false,
        error: `Server returned ${resp.status}`,
      };
    }

    return { available: true };
  } catch (err) {
    return {
      available: false,
      error: err.name === 'AbortError'
        ? 'Agent server health check timed out (5s)'
        : `Agent server unreachable: ${err.message}`,
    };
  }
}

// ─── Results Sanitization ──────────────────────────────────────────────────────

/**
 * Scalar metric keys to preserve when sanitizing results for the API.
 * All typed arrays (ventMask, data, etc.) are stripped to keep the
 * payload small and JSON-serializable.
 */
const SCALAR_KEYS = [
  'evansIndex',
  'evansSlice',
  'callosalAngle',
  'callosalSlice',
  'ventVolMl',
  'ventVolMm3',
  'nphScore',
  'nphPct',
  'ventCount',
  'processingTime',
  'modelId',
  'modelName',
  'shape',
  'spacing',
  'boundingBoxes',
];

/**
 * Pick only scalar/JSON-safe keys from a results object.
 *
 * @param {Object} obj - A results object (classical or model)
 * @returns {Object} Sanitized copy with only scalar metrics
 */
function pickScalars(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const out = {};
  for (const key of SCALAR_KEYS) {
    if (key in obj) {
      out[key] = obj[key];
    }
  }
  return out;
}

/**
 * Sanitize classical and multi-model results for API transmission.
 *
 * Strips ALL typed arrays (ventMask, data, volumeData, etc.) which can
 * be ~10MB+ each and are not JSON-serializable. Keeps only the scalar
 * metrics needed for AI interpretation.
 *
 * @param {Object} results - Classical pipeline results
 * @param {Object} [multiModelResults] - Map of modelId → model results
 * @returns {Object} Sanitized results safe for JSON body
 */
function sanitizeResultsForApi(results, multiModelResults) {
  const sanitized = {
    classical: pickScalars(results),
  };

  if (multiModelResults && typeof multiModelResults === 'object') {
    const models = {};
    for (const [modelId, modelResult] of Object.entries(multiModelResults)) {
      if (modelResult) {
        models[modelId] = pickScalars(modelResult);
      }
    }
    if (Object.keys(models).length > 0) {
      sanitized.models = models;
    }
  }

  return sanitized;
}

// ─── Interpretation Request ────────────────────────────────────────────────────

/**
 * Request an AI-powered interpretation of hydrocephalus morphometrics
 * from the Claude Agent SDK backend.
 *
 * Sends sanitized results (scalar metrics only, no typed arrays) and
 * receives a structured interpretation response.
 *
 * Uses a 65-second timeout (slightly above the server's 60s limit)
 * to let the server-side Claude conversation complete before aborting.
 *
 * @param {Object} results - Classical pipeline results
 * @param {Object} [multiModelResults] - Map of modelId → model results
 * @returns {Promise<Object>} Parsed interpretation response from the server
 * @throws {Error} On network failure, timeout, or non-ok HTTP status
 */
export async function requestInterpretation(results, multiModelResults) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 65000);

  try {
    const body = {
      results: sanitizeResultsForApi(results, multiModelResults),
    };

    const resp = await fetch(`${getBaseUrl()}/api/interpret`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      let errMsg = `Server returned ${resp.status}`;
      try {
        const errJson = await resp.json();
        errMsg = errJson.error || errJson.message || errMsg;
      } catch {
        // Response body was not JSON — use status code message
      }
      throw new Error(`Agent interpretation failed: ${errMsg}`);
    }

    return await resp.json();
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      throw new Error(
        'Agent interpretation timed out (65s). The server may be under heavy load.'
      );
    }

    // Re-throw errors we already created (non-ok status)
    if (err.message.startsWith('Agent interpretation')) {
      throw err;
    }

    // Network or other fetch errors
    throw new Error(`Agent interpretation request failed: ${err.message}`);
  }
}
