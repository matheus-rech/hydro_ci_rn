/**
 * ApiModelProvider — Real ML model API integration
 *
 * Calls external segmentation APIs (HuggingFace, Replicate, custom REST),
 * receives masks, then computes metrics locally using Morphometrics.js.
 *
 * Same interface as former MockModelProvider:
 *   generateResult(modelId, volumeData, classicalMask, shape, spacing) → ModelResult
 *
 * Author: Matheus Machado Rech
 */

import pako from 'pako';
import {
  voxelIndex,
  connectedComponents3D,
  computeEvansIndex,
  computeCallosalAngle,
} from '../pipeline/Morphometrics';
import { getModelConfig } from './ModelRegistry';

// ─── API Configuration ──────────────────────────────────────────────────────

const API_CONFIGS = {
  medsam2: {
    apiUrl: 'https://api-inference.huggingface.co/models/wanglab/medsam2',
    apiKeyEnv: 'HF_TOKEN',
    backend: 'huggingface',
    timeout: 60000,
  },
  sam3: {
    apiUrl: 'https://api.replicate.com/v1/predictions',
    modelVersion: 'meta/sam-2',
    apiKeyEnv: 'REPLICATE_API_TOKEN',
    backend: 'replicate',
    timeout: 120000,
    pollInterval: 2000,
  },
  yolovx: {
    apiUrl: null, // User-configurable endpoint
    apiKeyEnv: 'YOLOVX_API_KEY',
    backend: 'custom',
    timeout: 60000,
  },
};

// ─── Volume Serialization ───────────────────────────────────────────────────

function serializeVolumeForApi(volumeData, shape) {
  // Convert Float32Array → Uint8Array of the underlying buffer
  const f32 = volumeData instanceof Float32Array ? volumeData : new Float32Array(volumeData);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);

  // Gzip compress
  const compressed = pako.gzip(bytes);

  // Base64 encode (React Native has btoa available)
  let binary = '';
  for (let i = 0; i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i]);
  }
  return btoa(binary);
}

// ─── Mask Decoding ──────────────────────────────────────────────────────────

function decodeMaskResponse(base64Data, shape) {
  const expectedSize = shape[0] * shape[1] * shape[2];

  // Base64 decode
  const binaryStr = atob(base64Data);
  const compressed = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    compressed[i] = binaryStr.charCodeAt(i);
  }

  // Gzip decompress
  const raw = pako.inflate(compressed);

  // Validate size
  if (raw.length !== expectedSize) {
    throw new Error(
      `Mask size mismatch: got ${raw.length}, expected ${expectedSize} (${shape.join('×')})`
    );
  }

  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

// ─── Backend Adapters ───────────────────────────────────────────────────────

function getApiKey(envName) {
  // In React Native, env vars are injected at build time or read from config
  try {
    const Constants = require('expo-constants').default;
    const key = Constants.expoConfig?.extra?.[envName] || process.env[envName];
    if (key) return key;
  } catch (e) {
    // expo-constants not available
  }
  // Fallback: check global (set via app.config.js or manual injection)
  if (typeof global !== 'undefined' && global[envName]) return global[envName];
  return null;
}

async function callHuggingFace(config, volumeB64, shape, spacing) {
  const apiKey = getApiKey(config.apiKeyEnv);
  if (!apiKey) throw new Error(`Missing API key: ${config.apiKeyEnv}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: {
          volume_b64_gzip: volumeB64,
          shape,
          spacing,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`HuggingFace API ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    // Expect response.mask_b64_gzip (base64 gzipped Uint8Array)
    if (!result.mask_b64_gzip) {
      throw new Error('HuggingFace response missing mask_b64_gzip field');
    }

    return decodeMaskResponse(result.mask_b64_gzip, shape);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callReplicate(config, volumeB64, shape, spacing) {
  const apiKey = getApiKey(config.apiKeyEnv);
  if (!apiKey) throw new Error(`Missing API key: ${config.apiKeyEnv}`);

  // Create prediction
  const createResponse = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'respond-async',
    },
    body: JSON.stringify({
      version: config.modelVersion,
      input: {
        volume_b64_gzip: volumeB64,
        shape,
        spacing,
      },
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text().catch(() => 'unknown error');
    throw new Error(`Replicate create ${createResponse.status}: ${errorText}`);
  }

  const prediction = await createResponse.json();
  const pollUrl = prediction.urls?.get || `${config.apiUrl}/${prediction.id}`;

  // Poll for completion
  const deadline = Date.now() + config.timeout;
  while (Date.now() < deadline) {
    await delay(config.pollInterval);

    const pollResponse = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!pollResponse.ok) {
      throw new Error(`Replicate poll ${pollResponse.status}`);
    }

    const status = await pollResponse.json();

    if (status.status === 'succeeded') {
      if (!status.output?.mask_b64_gzip) {
        throw new Error('Replicate output missing mask_b64_gzip field');
      }
      return decodeMaskResponse(status.output.mask_b64_gzip, shape);
    }

    if (status.status === 'failed' || status.status === 'canceled') {
      throw new Error(`Replicate prediction ${status.status}: ${status.error || 'unknown'}`);
    }
    // status is 'starting' or 'processing' — continue polling
  }

  throw new Error('Replicate prediction timed out');
}

async function callCustomEndpoint(config, volumeB64, shape, spacing) {
  const apiKey = getApiKey(config.apiKeyEnv);
  if (!config.apiUrl) throw new Error('YOLOvx endpoint URL not configured');
  if (!apiKey) throw new Error(`Missing API key: ${config.apiKeyEnv}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        volume_b64_gzip: volumeB64,
        shape,
        spacing,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Custom endpoint ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    if (!result.mask_b64_gzip) {
      throw new Error('Custom endpoint response missing mask_b64_gzip field');
    }

    return decodeMaskResponse(result.mask_b64_gzip, shape);
  } finally {
    clearTimeout(timeoutId);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Bounding Boxes ─────────────────────────────────────────────────────────

function computeBoundingBoxes(mask, shape, spacing) {
  const [X, Y, Z] = shape;
  const { labels, counts } = connectedComponents3D(mask, shape);
  const voxelVol = spacing[0] * spacing[1] * spacing[2];
  const boxes = [];

  for (const [label, count] of counts) {
    if (count < 50) continue;

    let minX = X, maxX = 0, minY = Y, maxY = 0, minZ = Z, maxZ = 0;
    for (let z = 0; z < Z; z++) {
      for (let y = 0; y < Y; y++) {
        for (let x = 0; x < X; x++) {
          if (labels[voxelIndex(shape, x, y, z)] === label) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
        }
      }
    }

    boxes.push({
      minX, maxX, minY, maxY, minZ, maxZ,
      volumeMl: (count * voxelVol) / 1000,
      confidence: 1.0,  // Real model output — no mock confidence
    });
  }

  return boxes;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function generateResult(modelId, volumeData, classicalMask, shape, spacing) {
  const config = getModelConfig(modelId);
  if (!config) throw new Error(`Unknown model: ${modelId}`);

  const apiConfig = API_CONFIGS[modelId];
  if (!apiConfig) throw new Error(`No API config for model: ${modelId}`);

  const startTime = performance.now();

  // Serialize volume for API
  const volumeB64 = serializeVolumeForApi(volumeData, shape);

  // Call the appropriate backend adapter
  let mask;
  switch (apiConfig.backend) {
    case 'huggingface':
      mask = await callHuggingFace(apiConfig, volumeB64, shape, spacing);
      break;
    case 'replicate':
      mask = await callReplicate(apiConfig, volumeB64, shape, spacing);
      break;
    case 'custom':
      mask = await callCustomEndpoint(apiConfig, volumeB64, shape, spacing);
      break;
    default:
      throw new Error(`Unknown backend: ${apiConfig.backend}`);
  }

  // ── Compute metrics locally using existing Morphometrics functions ───
  let ventCount = 0;
  for (let i = 0; i < mask.length; i++) ventCount += mask[i];

  const evansResult = computeEvansIndex(volumeData, mask, shape, spacing);
  const callosalResult = computeCallosalAngle(mask, shape, spacing);

  const voxelVol = spacing[0] * spacing[1] * spacing[2];
  const ventVolMm3 = ventCount * voxelVol;
  const ventVolMl = ventVolMm3 / 1000;

  let nphScore = 0;
  if (evansResult.maxEvans > 0.3) nphScore++;
  if (callosalResult.angleDeg !== null && callosalResult.angleDeg < 90) nphScore++;
  if (ventVolMl > 50) nphScore++;
  const nphPct = Math.round((nphScore / 3) * 100);

  const boundingBoxes = computeBoundingBoxes(mask, shape, spacing);

  const processingTime = ((performance.now() - startTime) / 1000).toFixed(1);

  return {
    modelId,
    modelName: config.name,
    modelColor: config.color,
    colorRgb: config.colorRgb,
    evansIndex: evansResult.maxEvans,
    evansSlice: evansResult.bestSlice,
    evansData: evansResult,
    callosalAngle: callosalResult.angleDeg,
    callosalSlice: callosalResult.bestCoronalSlice,
    callosalData: callosalResult,
    ventVolMl,
    ventVolMm3,
    nphScore,
    nphPct,
    ventCount,
    ventMask: mask,
    shape,
    spacing,
    boundingBoxes,
    processingTime: `${processingTime}s`,
    processingTimeNum: parseFloat(processingTime),
  };
}
