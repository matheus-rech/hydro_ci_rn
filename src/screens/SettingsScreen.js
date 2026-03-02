/**
 * SettingsScreen — MedSAM2 Server Configuration
 *
 * Allows the user to configure the MedSAM2 backend server URL,
 * test connectivity, and understand how the AI segmentation works.
 *
 * The app works 100% offline without MedSAM2 — this screen only
 * configures the optional AI enhancement.
 *
 * Author: Matheus Machado Rech
 * License: Research use only — not for clinical diagnosis
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, radius, typography } from '../theme';
import { getServerUrl, setServerUrl, checkHealth, measureLatency } from '../pipeline/MedSAMClient';

// ─── Connection status type ────────────────────────────────────────────────────
// 'idle' | 'checking' | 'connected' | 'disconnected'

export default function SettingsScreen({ navigation }) {
  const [serverInput, setServerInput]     = useState(getServerUrl());
  const [connStatus, setConnStatus]       = useState('idle');
  const [serverInfo, setServerInfo]       = useState(null);  // { version, model, latencyMs }
  const [errMsg, setErrMsg]               = useState('');
  const [saved, setSaved]                 = useState(false);

  // Reset saved indicator after navigation re-focus
  useFocusEffect(
    useCallback(() => {
      setSaved(false);
    }, [])
  );

  // ── Auto-check on first render ─────────────────────────────────────────────
  useEffect(() => {
    handleCheckConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Save URL ───────────────────────────────────────────────────────────────

  function handleSave() {
    const trimmed = serverInput.trim();
    if (!trimmed) {
      setErrMsg('Server URL cannot be empty.');
      return;
    }
    setServerUrl(trimmed);
    setServerInput(trimmed);
    setSaved(true);
    setErrMsg('');
    setTimeout(() => setSaved(false), 2500);
  }

  // ── Check Connection ───────────────────────────────────────────────────────

  async function handleCheckConnection() {
    const trimmed = serverInput.trim();
    if (!trimmed) {
      setErrMsg('Enter a server URL first.');
      return;
    }

    // Temporarily apply the URL for the check
    const previous = getServerUrl();
    setServerUrl(trimmed);

    setConnStatus('checking');
    setErrMsg('');
    setServerInfo(null);

    try {
      const t0 = Date.now();
      const health = await checkHealth();
      const latencyMs = Date.now() - t0;

      if (health.available) {
        setConnStatus('connected');
        setServerInfo({
          version:   health.version   || '—',
          model:     health.model     || 'MedSAM2',
          gpuAvail:  health.gpu       ?? null,
          latencyMs,
        });
      } else {
        setConnStatus('disconnected');
        setErrMsg(
          health.reason === 'timeout'
            ? 'Connection timed out. Is the server running?'
            : 'Server not reachable. Check the URL and network.'
        );
        // Restore previous URL if the new one didn't connect
        setServerUrl(previous);
      }
    } catch (err) {
      setConnStatus('disconnected');
      setErrMsg(err.message || 'Connection check failed.');
      setServerUrl(previous);
    }
  }

  // ── Reset to default ───────────────────────────────────────────────────────

  function handleReset() {
    setServerInput('http://localhost:5000');
    setServerUrl('http://localhost:5000');
    setConnStatus('idle');
    setServerInfo(null);
    setErrMsg('');
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
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.titleRow}>
          <View style={styles.iconBox}>
            <Text style={styles.iconText}>⚙</Text>
          </View>
          <View>
            <Text style={styles.screenTitle}>Settings</Text>
            <Text style={styles.screenSubtitle}>MedSAM2 AI Segmentation</Text>
          </View>
        </View>
      </View>

      {/* Info card — what MedSAM2 does */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>What is MedSAM2?</Text>
        <Text style={styles.infoBody}>
          MedSAM2 is a medical image segmentation model based on SAM 2 (Segment Anything Model 2)
          fine-tuned on medical imaging data. When connected to a MedSAM2 backend server, HydroMorph
          can use AI-powered ventricle segmentation instead of the built-in threshold algorithm.
        </Text>
        <Text style={[styles.infoBody, { marginTop: 8 }]}>
          <Text style={{ color: colors.green, fontWeight: typography.semibold }}>
            The app works fully offline
          </Text>
          {' '}without MedSAM2. AI segmentation is an optional enhancement only.
        </Text>
      </View>

      {/* Server URL input */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>SERVER URL</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={serverInput}
            onChangeText={setServerInput}
            placeholder="http://localhost:5000"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={handleCheckConnection}
            accessibilityLabel="MedSAM2 server URL"
          />
        </View>
        <Text style={styles.inputHint}>
          Enter the base URL of your MedSAM2 Flask server (no trailing slash).
        </Text>
      </View>

      {/* Action buttons */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.actionBtnPrimary]}
          onPress={handleSave}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Save server URL"
        >
          <Text style={styles.actionBtnPrimaryText}>
            {saved ? '✓ Saved!' : 'Save URL'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.actionBtnSecondary,
            connStatus === 'checking' && styles.actionBtnDisabled]}
          onPress={handleCheckConnection}
          disabled={connStatus === 'checking'}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Check server connection"
        >
          {connStatus === 'checking' ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Text style={styles.actionBtnSecondaryText}>Check Connection</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Connection status indicator */}
      <StatusBadge status={connStatus} serverInfo={serverInfo} />

      {/* Error message */}
      {!!errMsg && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errMsg}</Text>
        </View>
      )}

      {/* Server info (when connected) */}
      {connStatus === 'connected' && serverInfo && (
        <View style={styles.serverInfoCard}>
          <Text style={styles.serverInfoTitle}>Server Details</Text>
          <InfoRow label="Model"    value={serverInfo.model} />
          <InfoRow label="Version"  value={serverInfo.version} />
          <InfoRow label="Latency"  value={`${serverInfo.latencyMs} ms`} />
          {serverInfo.gpuAvail !== null && (
            <InfoRow
              label="GPU"
              value={serverInfo.gpuAvail ? 'Available' : 'CPU only'}
              valueColor={serverInfo.gpuAvail ? colors.green : colors.yellow}
            />
          )}
        </View>
      )}

      {/* Reset button */}
      <TouchableOpacity
        style={styles.resetBtn}
        onPress={handleReset}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        <Text style={styles.resetBtnText}>Reset to Default (localhost:5000)</Text>
      </TouchableOpacity>

      {/* Pipeline explanation */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>HOW IT WORKS</Text>
        <View style={styles.stepList}>
          <PipelineStep
            number="1"
            title="Threshold Segmentation (always runs)"
            desc="The built-in algorithm extracts CSF voxels and isolates ventricles using Hounsfield Unit thresholds and morphological operations."
          />
          <PipelineStep
            number="2"
            title="MedSAM2 AI Segmentation (optional)"
            desc="If a MedSAM2 server is configured and reachable, HydroMorph sends the volume with a bounding box prompt. The AI mask replaces the threshold mask."
          />
          <PipelineStep
            number="3"
            title="Automatic Fallback"
            desc="If the server is unavailable or segmentation fails, the threshold pipeline result is used automatically — no action required."
          />
        </View>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          HydroMorph · Research use only · Not for clinical diagnosis
        </Text>
        <Text style={styles.footerAuthor}>Matheus Machado Rech</Text>
      </View>
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status, serverInfo }) {
  if (status === 'idle') return null;

  const config = {
    checking:     { bg: 'rgba(88,166,255,0.08)',  border: 'rgba(88,166,255,0.25)', dot: colors.accent, label: 'Checking…' },
    connected:    { bg: 'rgba(63,185,80,0.08)',   border: 'rgba(63,185,80,0.25)',  dot: colors.green,  label: 'Connected' },
    disconnected: { bg: 'rgba(248,81,73,0.08)',   border: 'rgba(248,81,73,0.25)',  dot: colors.red,    label: 'Disconnected' },
  }[status];

  if (!config) return null;

  return (
    <View style={[statusStyles.badge, { backgroundColor: config.bg, borderColor: config.border }]}>
      <View style={[statusStyles.dot, { backgroundColor: config.dot }]} />
      <Text style={[statusStyles.label, { color: config.dot }]}>{config.label}</Text>
    </View>
  );
}

const statusStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
  },
});

function InfoRow({ label, value, valueColor }) {
  return (
    <View style={infoRowStyles.row}>
      <Text style={infoRowStyles.label}>{label}</Text>
      <Text style={[infoRowStyles.value, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const infoRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.border2}80`,
  },
  label: {
    color: colors.muted,
    fontSize: typography.base,
  },
  value: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: typography.base,
  },
});

function PipelineStep({ number, title, desc }) {
  return (
    <View style={stepStyles.step}>
      <View style={stepStyles.numberBadge}>
        <Text style={stepStyles.number}>{number}</Text>
      </View>
      <View style={stepStyles.content}>
        <Text style={stepStyles.title}>{title}</Text>
        <Text style={stepStyles.desc}>{desc}</Text>
      </View>
    </View>
  );
}

const stepStyles = StyleSheet.create({
  step: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.border2}60`,
  },
  numberBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(88,166,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(88,166,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  number: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: typography.bold,
  },
  content: {
    flex: 1,
  },
  title: {
    color: colors.text,
    fontSize: typography.base,
    fontWeight: typography.semibold,
    marginBottom: 4,
  },
  desc: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
});

// ─── Main styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flexGrow: 1,
    padding: spacing.xl,
    paddingTop: Platform.OS === 'ios' ? 56 : spacing.huge,
    paddingBottom: spacing.huge,
    maxWidth: 560,
    alignSelf: 'center',
    width: '100%',
    gap: spacing.xl,
  },

  // Header
  header: {
    gap: spacing.lg,
  },
  backBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 0,
    minHeight: 36,
    justifyContent: 'center',
  },
  backBtnText: {
    color: colors.accent,
    fontSize: typography.md,
    fontWeight: typography.medium,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(88,166,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(88,166,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    fontSize: 22,
  },
  screenTitle: {
    fontSize: typography.xxl,
    fontWeight: typography.semibold,
    color: colors.text,
  },
  screenSubtitle: {
    fontSize: typography.sm,
    color: colors.muted,
    marginTop: 2,
  },

  // Info card
  infoCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  infoTitle: {
    color: colors.text,
    fontSize: typography.md,
    fontWeight: typography.semibold,
    marginBottom: 8,
  },
  infoBody: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
  },

  // Section
  section: {
    gap: spacing.md,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: typography.semibold,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },

  // Input
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: typography.base,
    fontFamily: 'monospace',
    minHeight: 48,
  },
  inputHint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: -4,
  },

  // Buttons
  actionRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  actionBtn: {
    flex: 1,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  actionBtnPrimary: {
    backgroundColor: colors.accent,
  },
  actionBtnPrimaryText: {
    color: colors.bg,
    fontSize: typography.md,
    fontWeight: typography.semibold,
  },
  actionBtnSecondary: {
    backgroundColor: 'rgba(88,166,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(88,166,255,0.3)',
  },
  actionBtnSecondaryText: {
    color: colors.accent,
    fontSize: typography.md,
    fontWeight: typography.medium,
  },
  actionBtnDisabled: {
    opacity: 0.6,
  },

  // Error box
  errorBox: {
    backgroundColor: 'rgba(248,81,73,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(248,81,73,0.25)',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: {
    color: colors.red,
    fontSize: typography.base,
    lineHeight: 20,
  },

  // Server info card (when connected)
  serverInfoCard: {
    backgroundColor: 'rgba(63,185,80,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(63,185,80,0.2)',
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  serverInfoTitle: {
    color: colors.green,
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },

  // Reset button
  resetBtn: {
    alignItems: 'center',
    padding: spacing.md,
  },
  resetBtnText: {
    color: colors.muted,
    fontSize: 12,
    textDecorationLine: 'underline',
  },

  // Pipeline steps
  stepList: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    overflow: 'hidden',
  },

  // Footer
  footer: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border2,
    gap: 4,
  },
  footerText: {
    color: colors.muted,
    fontSize: 11,
    textAlign: 'center',
    opacity: 0.6,
  },
  footerAuthor: {
    color: colors.muted,
    fontSize: 11,
    opacity: 0.5,
  },
});
