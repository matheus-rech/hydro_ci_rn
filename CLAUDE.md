# HydroMorph — Project Guide

## Overview

**HydroMorph** is a React Native (Expo SDK 51) medical imaging app that computes hydrocephalus morphometrics from head CT scans: Evans Index, Callosal Angle, and Ventricle Volume. It supports NIfTI, DICOM series, and image file inputs.

**Author**: Matheus Machado Rech
**Bundle ID**: `com.mmrech.hydromorph` (iOS + Android)

## Tech Stack

- React Native 0.74 + Expo SDK 51
- `pako` for gzip compression (NIfTI parsing + API payloads)
- `react-native-svg` for SVG overlays
- `expo-document-picker` + `expo-file-system` for file I/O
- `@react-navigation/stack` for screen navigation

## Architecture

### Screens (4)

| Screen | File | Purpose |
|--------|------|---------|
| Upload | `src/screens/UploadScreen.js` | File picker (NIfTI/DICOM/Image/Sample) |
| Processing | `src/screens/ProcessingScreen.js` | Pipeline execution with step-by-step progress |
| Results | `src/screens/ResultsScreen.js` | Morphometrics display + multi-model comparison |
| Settings | `src/screens/SettingsScreen.js` | App configuration |

### Pipeline (`src/pipeline/`)

| File | Purpose |
|------|---------|
| `Pipeline.js` | 9-step classical pipeline + multi-model orchestrator |
| `Morphometrics.js` | All morphological ops: dilate3D, opening3D, connectedComponents3D, Evans Index, Callosal Angle |
| `NiftiReader.js` | NIfTI file parser |
| `DicomReader.js` | DICOM series loader + single image parser |
| `MedSAMClient.js` | MedSAM2 AI segmentation client (HuggingFace Inference Endpoint) |

### Models (`src/models/`)

| File | Purpose |
|------|---------|
| `ApiModelProvider.js` | Real ML API integration (HuggingFace, Replicate, custom REST) |
| `ModelRegistry.js` | 4 model configs: classical, medsam2, sam3, yolovx |
| `ResultsStore.js` | Module-level store for large typed arrays (avoids RN serialization limits) |

### Components (`src/components/`)

| File | Purpose |
|------|---------|
| `SliceViewer.js` | Axial/Coronal slice renderer with mask overlay |
| `ComparisonView.js` | 2x2 grid multi-model slice comparison |
| `ModelSliceCard.js` | Per-model card with PNG encoder + SVG bounding box overlay |
| `MetricsComparisonTable.js` | Cross-model metrics table |
| `MetricCard.js` | Single metric display card |
| `NPHBadge.js` | NPH assessment badge |
| `ProgressSteps.js` | Pipeline step checklist with animated indicators |

## Multi-Model Pipeline

The pipeline runs the **classical** (local HU thresholding) pipeline first, then optionally calls ML model APIs:

1. **Classical** — Always runs locally, produces Evans Index, Callosal Angle, Volume
2. **MedSAM2** — HuggingFace Inference Endpoint (requires `MEDSAM2_API_URL` + `HF_TOKEN`)
3. **SAM3** — Replicate async polling (requires `REPLICATE_API_TOKEN` + `SAM3_MODEL_VERSION`)
4. **YOLOvx** — Custom REST endpoint (requires `YOLOVX_API_URL` + `YOLOVX_API_KEY`)

Each ML model failure is isolated — unconfigured models are cleanly skipped. The Comparison tab only appears when at least one ML model produces results.

## Environment Variables

API keys are injected via `app.config.js` → `expo-constants`. Set in `~/.zshrc`:

```bash
export HF_TOKEN="hf_..."                    # HuggingFace token (already set)
export MEDSAM2_API_URL="https://..."         # Deployed HF Inference Endpoint for MedSAM2
export REPLICATE_API_TOKEN="r8_..."          # Replicate API token
export SAM3_MODEL_VERSION="sha256:..."       # Replicate model version hash
export YOLOVX_API_URL="https://..."          # Custom YOLOvx endpoint
export YOLOVX_API_KEY="..."                  # YOLOvx API key
```

**Important**: `process.env` does NOT work at React Native runtime. All env vars must go through `app.config.js` → `Constants.expoConfig.extra`.

## CI/CD

- `.github/workflows/build.yml` — EAS build on push to main
- `.github/workflows/deploy-web.yml` — Web deployment
- `eas.json` — Build profiles
- Requires `EXPO_TOKEN` GitHub secret

## Development

```bash
npx expo start           # Start Metro bundler
npx expo start --ios     # iOS simulator
npx expo start --android # Android emulator
```

## Conventions

- Dark theme only (`colors.bg: #0d1117`)
- Monospace font for data values
- `typography` and `spacing` constants from `src/theme.js`
- No mocks — all model providers use real API backends
- Module-level stores for large data (ResultsStore pattern)
- Per-model error isolation in pipeline (try/catch per model, classical always succeeds)
