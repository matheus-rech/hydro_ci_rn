#!/usr/bin/env bash
# ============================================================================
# add_eas_workflows.sh — Add EAS Workflows to HydroMorph RN project
# Run from inside the hydro_ci_rn (or ~/Projects/hydro_ci_rn) folder
#
# Usage:
#   bash add_eas_workflows.sh
# ============================================================================

set -euo pipefail

[ -f "app.json" ] || { echo "Run this from inside the hydro_ci_rn folder"; exit 1; }

mkdir -p .eas/workflows

cat > .eas/workflows/build-production.yml << 'EOF'
name: Build Production Apps

on:
  push:
    branches: ['main']

jobs:
  build_android:
    name: Build Android
    type: build
    params:
      platform: android
      profile: production
  build_ios:
    name: Build iOS
    type: build
    params:
      platform: ios
      profile: production
EOF

cat > .eas/workflows/build-preview.yml << 'EOF'
name: Build Preview Apps

on:
  pull_request:
    branches: ['main']

jobs:
  build_android_preview:
    name: Build Android Preview
    type: build
    params:
      platform: android
      profile: preview
  build_ios_preview:
    name: Build iOS Preview
    type: build
    params:
      platform: ios
      profile: preview
EOF

cat > .eas/workflows/create-development-builds.yml << 'EOF'
name: Create Development Builds

jobs:
  android_dev:
    name: Build Android Dev
    type: build
    params:
      platform: android
      profile: development
  ios_device_dev:
    name: Build iOS Device Dev
    type: build
    params:
      platform: ios
      profile: development
  ios_simulator_dev:
    name: Build iOS Simulator Dev
    type: build
    params:
      platform: ios
      profile: development-simulator
EOF

echo "[✓] Created .eas/workflows/ with 3 workflow files"

cat > eas.json << 'EOF'
{
  "cli": {
    "version": ">= 12.0.0",
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "development-simulator": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": {
        "simulator": true
      }
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      },
      "ios": {
        "simulator": true
      }
    },
    "production": {
      "autoIncrement": true,
      "android": {
        "buildType": "app-bundle"
      },
      "ios": {
        "distribution": "store"
      }
    }
  },
  "submit": {
    "production": {}
  }
}
EOF

echo "[✓] Updated eas.json with development + development-simulator profiles"

echo ""
echo "Done. 3 EAS Workflows added:"
echo "  .eas/workflows/build-production.yml      — triggers on push to main"
echo "  .eas/workflows/build-preview.yml          — triggers on PR to main"
echo "  .eas/workflows/create-development-builds.yml — manual trigger only"
echo ""
echo "To test manually:"
echo "  npx eas-cli@latest workflow:run create-development-builds.yml"
echo ""
echo "To activate auto-triggers, commit and push:"
echo "  git add .eas/ eas.json && git commit -m 'Add EAS Workflows' && git push"
