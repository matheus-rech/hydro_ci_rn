/**
 * MedSAMClient — MedSAM2 API Client for React Native
 * HydroMorph — AI-powered ventricle segmentation via MedSAM2 backend
 *
 * Connects to a MedSAM2 Flask backend server to perform
 * AI-assisted ventricle segmentation. Falls back gracefully to the
 * threshold-based pipeline when the server is unavailable.
 *
 * Server API endpoints:
 *   GET  /api/health   — Health check
 *   POST /api/segment  — Run segmentation with volume + box prompt
 *
 * Author: Matheus Machado Rech
 * License: Research use only — not for clinical diagnosis
 */

'use strict';

import pako from 'pako';

// ─── Server Configuration ──────────────────────────────────────────────────────

const DEFAULT_SERVER = 'http://localhost:5000';
let serverUrl = DEFAULT_SERVER;

/**
 * Set the MedSAM2 server URL.
 * Strips trailing slashes automatically.
 * @param {string} url
 */
export function setServerUrl(url) {
  serverUrl = (url || DEFAULT_SERVER).replace(/\/+$/, '');
}

/**
 * Get the current MedSAM2 server URL.
 * @returns {string}
 */
export function getServerUrl() {
  return serverUrl;
}

// ─── Health Check ──────────────────────────────────────────────────────────────

/**
 * Check if the MedSAM2 server is reachable and healthy.
 * Uses a 5-second timeout to avoid blocking the UI.
 *
 * @returns {Promise<{ available: boolean, version?: string, model?: string }>}
 */
export async function checkHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(`${serverUrl}/api/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      return { available: false, statusCode: resp.status };
    }

    let json = {};
    try {
      json = await resp.json();
    } catch {
      // Server returned non-JSON but 200 OK — treat as available
    }

    return { available: true, ...json };
  } catch (err) {
    // AbortError = timeout; TypeError = network unreachable
    return {
      available: false,
      reason: err.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  }
}

// ─── Segmentation ──────────────────────────────────────────────────────────────

/**
 * Run MedSAM2 AI segmentation on a 3D brain CT volume.
 *
 * The volume data is windowed to brain CT HU range (-5 to 80),
 * normalized to 0–255, gzip-compressed, and sent to the server
 * as a multipart form upload.
 *
 * The server returns a gzip-compressed binary mask (Uint8Array)
 * with the same spatial dimensions as the input volume.
 *
 * @param {Float32Array} volumeData  - Flat 3D voxel array in HU
 * @param {number[]}     shape       - [X, Y, Z] voxel dimensions
 * @param {number[]}     spacing     - [sx, sy, sz] mm/voxel spacing
 * @param {number[]}     box         - [x1, y1, z1, x2, y2, z2] bounding box prompt in voxels
 * @returns {Promise<Uint8Array>}    - Binary ventricle mask (0/1)
 */
export async function segment(volumeData, shape, spacing, box) {
  const n = volumeData.length;

  // ── Window to brain CT HU range and normalize to 0–255 ──────────────────────
  const HU_MIN = -5;
  const HU_MAX = 80;
  const HU_RANGE = HU_MAX - HU_MIN;

  const windowed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hu = volumeData[i];
    const clamped = hu < HU_MIN ? HU_MIN : hu > HU_MAX ? HU_MAX : hu;
    windowed[i] = Math.round(((clamped - HU_MIN) / HU_RANGE) * 255);
  }

  // ── Gzip compress the windowed volume ─────────────────────────────────────────
  const compressed = pako.gzip(windowed);

  // ── Encode compressed bytes to base64 for multipart upload ───────────────────
  // React Native doesn't support Buffer, so we use a manual base64 encoding.
  const base64 = uint8ArrayToBase64(compressed);

  // ── Build FormData ─────────────────────────────────────────────────────────────
  const formData = new FormData();

  // Attach the compressed volume as a fake "file" blob
  formData.append('volume', {
    uri: `data:application/octet-stream;base64,${base64}`,
    type: 'application/octet-stream',
    name: 'volume.raw.gz',
  });

  formData.append('shape',   JSON.stringify(shape));
  formData.append('spacing', JSON.stringify(spacing));
  formData.append('box',     JSON.stringify(box));

  // ── POST request ──────────────────────────────────────────────────────────────
  const resp = await fetch(`${serverUrl}/api/segment`, {
    method: 'POST',
    body: formData,
    headers: {
      // NOTE: Do NOT manually set Content-Type here — React Native's fetch
      // automatically adds the correct multipart/form-data boundary
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    let errMsg = `Server returned ${resp.status}`;
    try {
      const errJson = await resp.json();
      errMsg = errJson.error || errJson.message || errMsg;
    } catch {
      // ignore JSON parse error
    }
    throw new Error(`MedSAM2 segmentation failed: ${errMsg}`);
  }

  // ── Decode response ────────────────────────────────────────────────────────────
  const result = await resp.json();

  if (!result.mask_b64_gzip) {
    throw new Error('MedSAM2 response missing mask_b64_gzip field');
  }

  // Decode base64 → Uint8Array → gunzip → binary mask
  const maskCompressedStr = atob(result.mask_b64_gzip);
  const maskCompressed = new Uint8Array(maskCompressedStr.length);
  for (let i = 0; i < maskCompressedStr.length; i++) {
    maskCompressed[i] = maskCompressedStr.charCodeAt(i);
  }

  const mask = pako.inflate(maskCompressed);
  return new Uint8Array(mask);
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Convert Uint8Array to base64 string without using Buffer.
 * Handles large arrays by chunking to avoid stack overflow.
 *
 * @param {Uint8Array} bytes
 * @returns {string} base64 string
 */
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Ping the server and return the round-trip latency in milliseconds.
 * Returns Infinity if server is unreachable.
 *
 * @returns {Promise<number>}
 */
export async function measureLatency() {
  const t0 = Date.now();
  const health = await checkHealth();
  if (!health.available) return Infinity;
  return Date.now() - t0;
}
