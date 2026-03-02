/**
 * app.config.js — Dynamic Expo config that injects env vars into the runtime
 *
 * Environment variables from ~/.zshrc are available at build/start time
 * via process.env, but NOT at React Native runtime. This file bridges
 * the gap by placing them into expo-constants → Constants.expoConfig.extra.
 *
 * Usage in app code:
 *   import Constants from 'expo-constants';
 *   const token = Constants.expoConfig?.extra?.HF_TOKEN;
 *
 * Author: Matheus Machado Rech
 */

const baseConfig = require('./app.json');

module.exports = ({ config }) => ({
  ...baseConfig.expo,
  ...config,
  extra: {
    ...baseConfig.expo.extra,
    // ── ML Model API Keys ────────────────────────────────────────────────
    HF_TOKEN: process.env.HF_TOKEN || null,
    REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN || null,
    YOLOVX_API_KEY: process.env.YOLOVX_API_KEY || null,

    // ── Configurable Endpoints ───────────────────────────────────────────
    // Override default URLs by setting these env vars.
    // Required for MedSAM2: deploy your own HF Inference Endpoint.
    MEDSAM2_API_URL: process.env.MEDSAM2_API_URL || null,
    SAM3_MODEL_VERSION: process.env.SAM3_MODEL_VERSION || null,
    YOLOVX_API_URL: process.env.YOLOVX_API_URL || null,
  },
});
