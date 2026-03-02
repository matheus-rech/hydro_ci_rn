/**
 * UploadScreen — File picker and entry point
 *
 * Allows users to:
 *  1. Pick a NIfTI (.nii / .nii.gz), DICOM (.dcm), or image (.png/.jpg) file
 *     via expo-document-picker (supports multi-select for DICOM series)
 *  2. Load the bundled sample CT scan
 *
 * File routing:
 *   .nii / .nii.gz       → NiftiReader (existing)
 *   .dcm or DICOM magic  → DicomReader.parseDicomSeries
 *   .png / .jpg / .jpeg  → DicomReader.parseImageFile
 *   Multiple files       → assumed to be DICOM series
 *
 * Author: Matheus Machado Rech
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { colors, spacing, radius, typography } from '../theme';
import { isDicomBuffer } from '../pipeline/DicomReader';

// ─── File type detection helpers ──────────────────────────────────────────────

function getFileType(name = '') {
  const lower = name.toLowerCase();
  if (lower.endsWith('.nii.gz') || lower.endsWith('.nii')) return 'nifti';
  if (lower.endsWith('.dcm') || lower.endsWith('.dicom')) return 'dicom';
  if (lower.endsWith('.png')) return 'image';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image';
  return 'unknown';
}

/**
 * Determine file type from name + optionally sniff the magic bytes.
 * Returns 'nifti' | 'dicom' | 'image' | 'unknown'
 */
function detectFileType(name, dicomMagicConfirmed = false) {
  const byName = getFileType(name);
  if (byName !== 'unknown') return byName;
  if (dicomMagicConfirmed) return 'dicom';
  return 'unknown';
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function UploadScreen({ navigation }) {
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError]   = useState('');

  // ── File picker ─────────────────────────────────────────────────────────────

  async function handlePickFile() {
    setError('');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // Accept NIfTI, DICOM, and common image types
        type: Platform.OS === 'ios'
          ? ['public.data', 'org.gnu.gnu-zip-archive', 'org.dicom.dcm', 'public.image']
          : ['*/*'],
        copyToCacheDirectory: true,
        multiple: true,  // Allow multiple files for DICOM series
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const assets = result.assets;

      // ── Multiple files → DICOM series ──────────────────────────────────────
      if (assets.length > 1) {
        // Validate all files are DICOM-compatible
        const nonDicom = assets.filter(a => {
          const t = getFileType(a.name || '');
          return t === 'nifti' || t === 'image';
        });
        if (nonDicom.length > 0) {
          setError(
            'When selecting multiple files, all must be DICOM (.dcm) files for a series. ' +
            'For NIfTI or image files, select a single file.'
          );
          return;
        }

        await startProcessing({
          assets,
          fileType: 'dicom-series',
          fileName: `DICOM Series (${assets.length} slices)`,
          fileSize: assets.reduce((s, a) => s + (a.size || 0), 0),
          isSample: false,
        });
        return;
      }

      // ── Single file ────────────────────────────────────────────────────────
      const asset = assets[0];
      const name  = (asset.name || '').toLowerCase();
      const type  = detectFileType(name);

      if (type === 'unknown') {
        setError(
          'Unsupported file format. Please select a NIfTI (.nii, .nii.gz), ' +
          'DICOM (.dcm), or image (.png, .jpg) file.'
        );
        return;
      }

      await startProcessing({
        assets: [asset],
        fileType: type,
        fileName: asset.name,
        fileSize: asset.size || 0,
        isSample: false,
      });

    } catch (err) {
      if (err.code === 'DOCUMENT_PICKER_CANCELED') return;
      setError(err.message || 'Failed to pick file.');
    }
  }

  // ── Sample data ─────────────────────────────────────────────────────────────

  async function handleSample() {
    setError('');
    await startProcessing({ fileType: 'sample', isSample: true });
  }

  // ── Shared processing entry ──────────────────────────────────────────────────

  async function startProcessing({ assets, fileType, fileName, fileSize, isSample }) {
    setLoading(true);
    setLoadingMsg('');

    try {
      if (isSample || fileType === 'sample') {
        navigation.navigate('Processing', {
          fileType:  'sample',
          fileName:  'Sample CT — CADS BrainCT-1mm Subject 155',
          fileSize:  0,
          isSample:  true,
        });
        return;
      }

      if (fileType === 'nifti') {
        // Single NIfTI file — pass URI directly to ProcessingScreen
        navigation.navigate('Processing', {
          fileType:  'nifti',
          uri:       assets[0].uri,
          fileName:  fileName,
          fileSize:  fileSize,
          isSample:  false,
        });
        return;
      }

      if (fileType === 'dicom' || fileType === 'dicom-series') {
        // Read each DICOM file as base64 → ArrayBuffer, then navigate
        // We show a loading message since 100+ files can take a few seconds
        setLoadingMsg(
          assets.length > 1
            ? `Reading ${assets.length} DICOM files…`
            : 'Reading DICOM file…'
        );

        const FileSystem = require('expo-file-system');
        const buffers = [];

        for (let i = 0; i < assets.length; i++) {
          if (assets.length > 10) {
            setLoadingMsg(`Reading DICOM files… ${i + 1} / ${assets.length}`);
          }
          const b64 = await FileSystem.readAsStringAsync(assets[i].uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          const bin = atob(b64);
          const buf = new ArrayBuffer(bin.length);
          const u8  = new Uint8Array(buf);
          for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
          buffers.push(buf);
        }

        navigation.navigate('Processing', {
          fileType:   'dicom',
          dicomBuffers: null,   // We can't pass buffers through nav params easily
          // Instead, pass URIs and let ProcessingScreen re-read them
          uris:       assets.map(a => a.uri),
          fileName:   fileName,
          fileSize:   fileSize,
          isSample:   false,
          numSlices:  assets.length,
        });
        return;
      }

      if (fileType === 'image') {
        navigation.navigate('Processing', {
          fileType: 'image',
          uri:      assets[0].uri,
          fileName: fileName,
          fileSize: fileSize,
          isSample: false,
        });
        return;
      }

    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.logoMark}>
          <Text style={styles.logoIcon}>🧠</Text>
        </View>
        <Text style={styles.appTitle}>HydroMorph</Text>
        <Text style={styles.appSubtitle}>Hydrocephalus Morphometrics Pipeline</Text>
      </View>

      {/* Drop Zone / File Picker */}
      <TouchableOpacity
        style={styles.dropZone}
        onPress={handlePickFile}
        activeOpacity={0.7}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Select a head CT scan file"
      >
        {loading ? (
          <>
            <ActivityIndicator size="large" color={colors.accent} style={{ marginBottom: 16 }} />
            <Text style={styles.dropTitle}>{loadingMsg || 'Loading…'}</Text>
          </>
        ) : (
          <>
            <Text style={styles.dropIcon}>⬆</Text>
            <Text style={styles.dropTitle}>Tap to select a head CT scan</Text>
            <Text style={styles.dropHint}>
              NIfTI, DICOM, or images.{'\\n'}Processes entirely on-device.
            </Text>
            {/* Format badges */}
            <View style={styles.formatRow}>
              <FormatBadge label=".nii" />
              <FormatBadge label=".nii.gz" />
              <FormatBadge label=".dcm" color={colors.cyan} />
              <FormatBadge label=".png" color={colors.green} />
              <FormatBadge label=".jpg" color={colors.green} />
            </View>
          </>
        )}
      </TouchableOpacity>

      {/* Error */}
      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Privacy strip */}
      <View style={styles.privacyStrip}>
        <Text style={styles.privacyIcon}>🔒</Text>
        <Text style={styles.privacyText}>
          <Text style={styles.privacyBold}>100% On-Device</Text>
          {' '}— All processing happens locally. Zero server uploads.
        </Text>
      </View>

      {/* Sample data button */}
      <TouchableOpacity
        style={styles.sampleBtn}
        onPress={handleSample}
        activeOpacity={0.7}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Try with sample CT scan"
      >
        <Text style={styles.sampleBtnIcon}>📂</Text>
        <Text style={styles.sampleBtnText}>Try with sample CT scan</Text>
      </TouchableOpacity>

      {/* Settings link */}
      <TouchableOpacity
        style={styles.settingsBtn}
        onPress={() => navigation.navigate('Settings')}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Open settings"
      >
        <Text style={styles.settingsBtnIcon}>⚙</Text>
        <Text style={styles.settingsBtnText}>MedSAM2 AI Settings</Text>
      </TouchableOpacity>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerLine}>
          Supports NIfTI · DICOM · PNG/JPG · Head CT in Hounsfield Units
        </Text>
        <Text style={styles.footerLine}>
          Built by{' '}
          <Text style={{ color: colors.accent, fontWeight: typography.semibold }}>
            Matheus Machado Rech
          </Text>
        </Text>
        <Text style={styles.footerDisclaimer}>
          Research use only · Not for clinical diagnosis
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FormatBadge({ label, color }) {
  return (
    <View style={[
      styles.formatBadge,
      color && {
        backgroundColor: `${color}18`,
        borderColor: `${color}40`,
      },
    ]}>
      <Text style={[styles.formatBadgeText, color && { color }]}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    paddingTop: spacing.huge,
    paddingBottom: spacing.huge,
  },

  // Header
  header: {
    alignItems: 'center',
    marginBottom: spacing.huge,
  },
  logoMark: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: 'rgba(88,166,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(88,166,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  logoIcon: {
    fontSize: 32,
  },
  appTitle: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.accent,
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  appSubtitle: {
    color: colors.muted,
    fontSize: typography.sm,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: typography.medium,
  },

  // Drop zone
  dropZone: {
    width: '100%',
    maxWidth: 480,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.huge,
    alignItems: 'center',
    backgroundColor: colors.surface,
    minHeight: 240,
    justifyContent: 'center',
  },
  dropIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  dropTitle: {
    fontSize: typography.xl,
    fontWeight: typography.semibold,
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  dropHint: {
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 20,
  },
  formatRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 16,
    justifyContent: 'center',
  },
  formatBadge: {
    backgroundColor: 'rgba(88,166,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(88,166,255,0.25)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  formatBadgeText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: colors.accent,
    letterSpacing: 0.5,
  },

  // Error
  errorBox: {
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: 'rgba(248,81,73,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(248,81,73,0.3)',
    borderRadius: radius.md,
    maxWidth: 480,
    width: '100%',
  },
  errorText: {
    color: colors.red,
    fontSize: typography.base,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Privacy strip
  privacyStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: spacing.xl,
    padding: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: 'rgba(63,185,80,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(63,185,80,0.2)',
    maxWidth: 480,
    width: '100%',
  },
  privacyIcon: {
    fontSize: 16,
  },
  privacyText: {
    color: colors.green,
    fontSize: 12,
    flex: 1,
    lineHeight: 18,
  },
  privacyBold: {
    fontWeight: typography.semibold,
  },

  // Sample button
  sampleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    padding: 14,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: 'rgba(88,166,255,0.08)',
    maxWidth: 480,
    width: '100%',
    minHeight: 48,
  },
  sampleBtnIcon: {
    fontSize: 16,
  },
  sampleBtnText: {
    color: colors.accent,
    fontSize: typography.md,
    fontWeight: typography.medium,
  },

  // Settings button
  settingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    padding: 12,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.02)',
    maxWidth: 480,
    width: '100%',
    minHeight: 44,
  },
  settingsBtnIcon: {
    fontSize: 14,
    color: colors.muted,
  },
  settingsBtnText: {
    color: colors.muted,
    fontSize: typography.base,
    fontWeight: typography.medium,
  },

  // Footer
  footer: {
    marginTop: spacing.huge,
    alignItems: 'center',
  },
  footerLine: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 22,
  },
  footerDisclaimer: {
    color: colors.muted,
    fontSize: 11,
    textAlign: 'center',
    opacity: 0.5,
    marginTop: 4,
  },
});
