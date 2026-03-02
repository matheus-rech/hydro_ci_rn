# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HydroMorph — React Native (Expo SDK 51) medical imaging app that computes hydrocephalus morphometrics (Evans Index, Callosal Angle, Ventricle Volume) from head CT scans. Supports NIfTI, DICOM series, and image file inputs.

Bundle ID: `com.mmrech.hydromorph` (iOS + Android)

## Commands

```bash
npm ci                    # Install dependencies
npx expo start            # Start Metro bundler (dev)
npx expo start --ios      # iOS simulator
npx expo start --android  # Android emulator

# EAS builds (requires EXPO_TOKEN)
eas build --platform android --profile preview --non-interactive
eas build --platform ios --profile preview --non-interactive
```

No test framework is configured. No linter is configured.

## Architecture

### Navigation Flow

```
Upload → Processing → Results
Upload → Settings
```

`App.js` sets up a `@react-navigation/stack` navigator with 4 screens. All headers are hidden; the app uses custom top bars. Settings slides up from bottom via custom `cardStyleInterpolator`.

### Core Data Flow

1. **Upload** picks a file (NIfTI/DICOM/Image/Sample) and passes `{ fileType, uri, uris, fileName, fileSize }` to Processing via navigation params.
2. **Processing** loads the volume, then calls `runMultiModelPipeline(volume, onProgress)` which:
   - Runs the 9-step **classical pipeline** locally (always succeeds)
   - Sequentially attempts each ML model API (medsam2, sam3, yolovx), skipping unconfigured ones
   - Returns `{ classical, medsam2?, sam3?, yolovx? }` map
3. Results are stored in **ResultsStore** (module-level `let _results = null`) to avoid React Navigation's serialization limit on typed arrays (~10MB ventricle masks). Only `{ results: classical, volume, hasMultiModel }` passes via nav params.
4. **Results** retrieves full multi-model data from `getResults()` and shows Detail tab (classical metrics) and optionally a Comparison tab (2×2 grid, metrics table).

### Volume Object

The central data structure passed through the pipeline:

```js
{
  shape: [X, Y, Z],       // voxel dimensions
  spacing: [sx, sy, sz],   // mm per voxel
  data: Float32Array,      // HU values, length = X*Y*Z
  header: { bitpix, source, ... },
  fileSize: number
}
```

Voxel indexing: `index = x + y * X + z * X * Y` (via `voxelIndex(shape, x, y, z)` in Morphometrics.js).

### Classical Pipeline (Pipeline.js → runPipeline)

9-step HU-thresholding pipeline, all running locally in JavaScript:

1. Parse volume header
2. Brain mask via HU thresholding (-5 to 80) + morphological closing + largest component
3. CSF extraction (HU 0-22) within brain mask
4. Morphological opening (adaptive to voxel spacing 0.7-2.5mm range)
5. Restrict to central 60% of brain bbox + component filtering (>0.5mL) + optional MedSAM2 AI segmentation
6. Evans Index computation per axial slice
7. Callosal angle on coronal view
8. Ventricle volume from voxel count × voxel volume
9. NPH score: 3-criteria (Evans >0.3, Angle <90°, Volume >50mL)

### Multi-Model Pipeline (Pipeline.js → runMultiModelPipeline)

Extends classical with ML model APIs. Each model is isolated via try/catch. `validateModelConfig()` checks keys/URLs **before** the expensive volume serialization (gzip + base64 of Float32Array).

| Model | Backend | Required Env Vars |
|-------|---------|-------------------|
| medsam2 | HuggingFace Inference Endpoint | `HF_TOKEN` + `MEDSAM2_API_URL` |
| sam3 | Replicate (async polling) | `REPLICATE_API_TOKEN` + `SAM3_MODEL_VERSION` |
| yolovx | Custom REST | `YOLOVX_API_KEY` + `YOLOVX_API_URL` |

API request format: volume as gzip-compressed Float32Array, base64-encoded. Response: gzip-compressed Uint8Array mask, base64-encoded.

### Environment Variable Injection

**Critical**: `process.env` does NOT work at React Native runtime. The chain is:

`~/.zshrc` → `app.config.js` reads `process.env` at Metro start → `Constants.expoConfig.extra` at runtime

In app code: `import Constants from 'expo-constants'; Constants.expoConfig?.extra?.HF_TOKEN`

After adding/changing env vars, restart Metro (`npx expo start`).

## Key Conventions

- Dark theme only — all colors, spacing, radius, typography from `src/theme.js` (GitHub Dark palette, `bg: #0d1117`)
- `statusColor()`, `nphLevelColor()`, `nphLevelLabel()` helpers in theme.js for clinical status rendering
- Monospace font for all data values
- No mocks — all model providers use real API backends
- Module-level stores for large data to avoid React Navigation serialization limits (ResultsStore pattern)
- Comparison tab only renders when `hasMultiModel` is true (derived from actual ML model results, not configuration)
- ComparisonView and MetricsComparisonTable filter to only show models with results
- `ModelRegistry.js` defines model colors — each model has `color` (hex) and `colorRgb` ({r,g,b}) for mask overlay rendering via `SliceViewer`'s `overlayColor` prop

## CI/CD

- `.github/workflows/build.yml` — EAS build on push to main (Android APK + iOS simulator, `preview` profile)
- Requires `EXPO_TOKEN` GitHub secret
- `eas.json` has profiles: `development`, `development-simulator`, `preview`, `production`
