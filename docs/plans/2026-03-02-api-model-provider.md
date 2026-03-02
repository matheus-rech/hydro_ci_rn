# ApiModelProvider & Integration Finalization Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace mock model providers with real API backends (HuggingFace, Replicate, custom REST) and finalize the multi-model comparison feature on the `feature/multi-model-comparison` branch.

**Architecture:** Config-driven API adapters per model backend. Volume data is gzip-compressed + base64-encoded for transmission. Returned segmentation masks are decoded and metrics are computed locally using existing Morphometrics.js functions. Each model adapter is isolated so failures are caught per-model.

**Tech Stack:** React Native + Expo SDK 51, pako (gzip), fetch API, HuggingFace Inference Endpoints, Replicate API (polling), custom REST.

---

### Task 1: Create ApiModelProvider.js — config + serialization layer

**Files:**
- Create: `src/models/ApiModelProvider.js`

**Context:** This file replaces `MockModelProvider.js` (which exists in the fork but was NOT copied to hydro_ci_rn per plan). Pipeline.js already imports `{ generateResult } from '../models/ApiModelProvider'` — so this file must export that function.

**Step 1: Create ApiModelProvider.js with API configs and serialization helpers**

```javascript
// src/models/ApiModelProvider.js
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
```

**Step 2: Add volume serialization function**

This compresses Float32Array volume data with pako gzip, then base64-encodes it for API transmission.

```javascript
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
```

**Step 3: Add mask decoding function**

Decodes API response (base64 gzip → Uint8Array mask) with size validation.

```javascript
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
```

**Step 4: Commit**

```bash
git add src/models/ApiModelProvider.js
git commit -m "feat(api): add ApiModelProvider config + serialization layer"
```

---

### Task 2: Add backend-specific API adapters

**Files:**
- Modify: `src/models/ApiModelProvider.js`

**Step 1: Add the HuggingFace adapter**

Appended after the decode function. Simple single POST → response pattern.

```javascript
// ─── Backend Adapters ───────────────────────────────────────────────────────

function getApiKey(envName) {
  // In React Native, env vars are injected at build time or read from config
  // For development, they come from process.env or Constants
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
```

**Step 2: Add the Replicate adapter (with polling)**

Replicate uses an async pattern: POST to create prediction → poll until succeeded.

```javascript
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
```

**Step 3: Add the custom REST adapter**

```javascript
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
```

**Step 4: Commit**

```bash
git add src/models/ApiModelProvider.js
git commit -m "feat(api): add HuggingFace, Replicate, and custom REST adapters"
```

---

### Task 3: Add bounding boxes + main `generateResult` export

**Files:**
- Modify: `src/models/ApiModelProvider.js`

**Context:** This is the public interface that `Pipeline.js` calls. It routes to the correct adapter, decodes the mask, computes metrics locally (reusing Morphometrics.js), and builds the ModelResult object.

**Step 1: Add computeBoundingBoxes (ported from MockModelProvider, without mock confidence)**

```javascript
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
```

**Step 2: Add the main `generateResult` export**

```javascript
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
```

**Step 3: Commit**

```bash
git add src/models/ApiModelProvider.js
git commit -m "feat(api): add generateResult with local metric computation"
```

---

### Task 4: Commit framework changes + push branch

**Files:** All modified/new files from Tasks 2a–2b (already done in working tree)

**Step 1: Stage all changes and commit the multi-model framework**

```bash
git add .gitignore src/models/ModelRegistry.js src/models/ResultsStore.js \
  src/components/ComparisonView.js src/components/MetricsComparisonTable.js \
  src/components/ModelSliceCard.js src/pipeline/Morphometrics.js \
  src/components/SliceViewer.js src/pipeline/Pipeline.js \
  src/screens/ProcessingScreen.js src/screens/ResultsScreen.js

git commit -m "feat: add multi-model comparison framework

- ModelRegistry with 4 model configs (classical, MedSAM2, SAM3, YOLOvx)
- ResultsStore for module-level typed array storage
- ComparisonView with 2x2 grid, shared slider, metrics table
- ModelSliceCard with PNG encoder + SVG bounding box overlay
- MetricsComparisonTable with clinical threshold highlighting
- overlayColor param in Morphometrics pixel generators
- Multi-model pipeline in Pipeline.js
- Tab bar (Detail/Comparison) in ResultsScreen
- Enhanced .gitignore"
```

**Step 2: Push the feature branch**

```bash
git push -u origin feature/multi-model-comparison
```

---

### Task 5: Verify, merge to main, push

**Step 1: Verify app launches**

```bash
npx expo start --web 2>&1 | head -20
# Expected: no import errors, Metro bundler starts
```

**Step 2: Verify zero MockModelProvider references**

```bash
grep -r "MockModelProvider" src/ --include="*.js"
# Expected: no output
```

**Step 3: Merge to main and push**

```bash
git checkout main
git merge feature/multi-model-comparison
git push origin main
```

**Step 4: Verify clean state**

```bash
git status
git log --oneline -5
```

Expected: clean working tree, merge commit on main.
