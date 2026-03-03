/**
 * AIInterpretation — Claude Agent SDK–powered clinical interpretation
 *
 * Connects to the HydroMorph Agent Server to request AI-powered
 * interpretation of hydrocephalus morphometrics.
 *
 * States:
 *   checking     → Agent health check in progress
 *   unavailable  → Server not reachable or not configured
 *   ready        → Waiting for user to request interpretation
 *   loading      → Interpretation in progress
 *   display      → Showing structured interpretation
 *   error        → Request failed after attempting
 *
 * Author: Matheus Machado Rech
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { colors, spacing, radius, typography } from '../theme';
import { checkAgentHealth, requestInterpretation } from '../services/AgentService';

// ─── Status Badge Colors ─────────────────────────────────────────────────────

const STATUS_COLORS = {
  normal:    colors.green,
  borderline: colors.yellow,
  abnormal:  colors.red,
};

const LIKELIHOOD_COLORS = {
  low:      colors.green,
  moderate: colors.yellow,
  high:     colors.red,
};

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AIInterpretation({ results, multiModelResults }) {
  const [state, setState] = useState('checking'); // checking|unavailable|ready|loading|display|error
  const [interpretation, setInterpretation] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // ── Health check on mount ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const health = await checkAgentHealth();
      if (cancelled) return;
      setState(health.available ? 'ready' : 'unavailable');
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Fade-in animation when interpretation arrives ────────────────────────
  useEffect(() => {
    if (state === 'display') {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }
  }, [state]);

  // ── Pulse animation during loading ───────────────────────────────────────
  useEffect(() => {
    if (state === 'loading') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.6, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1.0, duration: 800, useNativeDriver: true }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [state]);

  // ── Request interpretation ───────────────────────────────────────────────
  async function handleRequest() {
    setState('loading');
    setErrorMsg(null);

    try {
      const response = await requestInterpretation(results, multiModelResults);
      if (response?.success && response.interpretation) {
        setInterpretation(response.interpretation);
        setState('display');
      } else {
        setErrorMsg('Received an unexpected response format.');
        setState('error');
      }
    } catch (err) {
      setErrorMsg(err.message || 'Interpretation request failed.');
      setState('error');
    }
  }

  // ── Render by state ──────────────────────────────────────────────────────

  // Checking health
  if (state === 'checking') {
    return (
      <View style={styles.container}>
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={colors.purple} />
          <Text style={styles.statusText}>Checking AI agent availability…</Text>
        </View>
      </View>
    );
  }

  // Unavailable
  if (state === 'unavailable') {
    return (
      <View style={[styles.container, styles.unavailableContainer]}>
        <Text style={styles.unavailableTitle}>AI Interpretation Unavailable</Text>
        <Text style={styles.unavailableDetail}>
          The Agent server is not reachable. Start it with:{'\n'}
          <Text style={styles.codeText}>cd server && npm start</Text>
        </Text>
      </View>
    );
  }

  // Ready — show request button
  if (state === 'ready') {
    return (
      <View style={styles.container}>
        <View style={styles.readyContent}>
          <View style={styles.aiIconContainer}>
            <Text style={styles.aiIcon}>✦</Text>
          </View>
          <Text style={styles.readyTitle}>AI Clinical Interpretation</Text>
          <Text style={styles.readyDetail}>
            Get an AI-powered neuroradiology interpretation of your morphometric results using Claude.
          </Text>
          <TouchableOpacity
            style={styles.requestBtn}
            onPress={handleRequest}
            activeOpacity={0.8}
          >
            <Text style={styles.requestBtnText}>Generate Interpretation</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Loading
  if (state === 'loading') {
    return (
      <View style={styles.container}>
        <Animated.View style={[styles.loadingContent, { opacity: pulseAnim }]}>
          <ActivityIndicator size="large" color={colors.purple} />
          <Text style={styles.loadingTitle}>Analyzing results…</Text>
          <Text style={styles.loadingDetail}>
            Claude is reviewing your morphometrics with medical knowledge tools.
          </Text>
        </Animated.View>
      </View>
    );
  }

  // Error
  if (state === 'error') {
    return (
      <View style={[styles.container, styles.errorContainer]}>
        <Text style={styles.errorTitle}>Interpretation Failed</Text>
        <Text style={styles.errorDetail}>{errorMsg}</Text>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={handleRequest}
          activeOpacity={0.8}
        >
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Display interpretation
  if (state === 'display' && interpretation) {
    const interp = interpretation;
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        {/* Summary */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryHeader}>
            <Text style={styles.aiIcon}>✦</Text>
            <Text style={styles.summaryLabel}>AI Summary</Text>
            {interp.nphLikelihood && interp.nphLikelihood !== 'unknown' && (
              <View style={[
                styles.likelihoodBadge,
                { backgroundColor: `${LIKELIHOOD_COLORS[interp.nphLikelihood] || colors.muted}15` },
                { borderColor: `${LIKELIHOOD_COLORS[interp.nphLikelihood] || colors.muted}40` },
              ]}>
                <Text style={[
                  styles.likelihoodText,
                  { color: LIKELIHOOD_COLORS[interp.nphLikelihood] || colors.muted },
                ]}>
                  {interp.nphLikelihood.toUpperCase()} NPH RISK
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.summaryText}>{interp.summary}</Text>
        </View>

        {/* Findings */}
        {interp.findings && interp.findings.length > 0 && (
          <View style={styles.findingsContainer}>
            <Text style={styles.subsectionTitle}>Findings</Text>
            {interp.findings.map((f, i) => (
              <View key={i} style={styles.findingRow}>
                <View style={[
                  styles.findingDot,
                  { backgroundColor: STATUS_COLORS[f.status] || colors.muted },
                ]} />
                <View style={styles.findingBody}>
                  <View style={styles.findingHeader}>
                    <Text style={styles.findingMetric}>{f.metric}</Text>
                    <Text style={[
                      styles.findingStatus,
                      { color: STATUS_COLORS[f.status] || colors.muted },
                    ]}>
                      {f.status}
                    </Text>
                  </View>
                  <Text style={styles.findingDetail}>{f.detail}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Impression */}
        {interp.impression && (
          <View style={styles.impressionContainer}>
            <Text style={styles.subsectionTitle}>Clinical Impression</Text>
            <Text style={styles.impressionText}>{interp.impression}</Text>
          </View>
        )}

        {/* Recommendations */}
        {interp.recommendations && interp.recommendations.length > 0 && (
          <View style={styles.recsContainer}>
            <Text style={styles.subsectionTitle}>Recommendations</Text>
            {interp.recommendations.map((rec, i) => (
              <View key={i} style={styles.recRow}>
                <Text style={styles.recBullet}>→</Text>
                <Text style={styles.recText}>{rec}</Text>
              </View>
            ))}
          </View>
        )}

        {/* ICD-10 Codes */}
        {interp.icd10Codes && interp.icd10Codes.length > 0 && (
          <View style={styles.icdContainer}>
            <Text style={styles.subsectionTitle}>ICD-10 Codes</Text>
            {interp.icd10Codes.map((icd, i) => (
              <View key={i} style={styles.icdRow}>
                <Text style={styles.icdCode}>{icd.code}</Text>
                <Text style={styles.icdDesc}>{icd.description}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Disclaimer */}
        <View style={styles.disclaimerContainer}>
          <Text style={styles.disclaimerText}>
            {interp.disclaimer || 'AI-generated interpretation. Not a substitute for professional medical diagnosis.'}
          </Text>
        </View>

        {/* Regenerate */}
        <TouchableOpacity
          style={styles.regenerateBtn}
          onPress={handleRequest}
          activeOpacity={0.8}
        >
          <Text style={styles.regenerateBtnText}>↻ Regenerate</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  }

  return null;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.md,
  },

  // Status row (checking)
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusText: {
    fontSize: typography.sm,
    color: colors.muted,
  },

  // Unavailable
  unavailableContainer: {
    borderColor: `${colors.muted}40`,
    backgroundColor: `${colors.muted}08`,
  },
  unavailableTitle: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.muted,
  },
  unavailableDetail: {
    fontSize: typography.sm,
    color: colors.muted,
    lineHeight: 18,
  },
  codeText: {
    fontFamily: 'monospace',
    fontSize: typography.sm,
    color: colors.accent,
  },

  // Ready
  readyContent: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  aiIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: `${colors.purple}15`,
    borderWidth: 1,
    borderColor: `${colors.purple}30`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiIcon: {
    fontSize: 18,
    color: colors.purple,
  },
  readyTitle: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
    color: colors.text,
  },
  readyDetail: {
    fontSize: typography.sm,
    color: colors.muted,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 18,
  },
  requestBtn: {
    backgroundColor: colors.purple,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
  },
  requestBtnText: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: '#fff',
    letterSpacing: 0.3,
  },

  // Loading
  loadingContent: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  loadingTitle: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
    color: colors.purple,
  },
  loadingDetail: {
    fontSize: typography.sm,
    color: colors.muted,
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 18,
  },

  // Error
  errorContainer: {
    borderColor: `${colors.red}30`,
    backgroundColor: `${colors.red}08`,
  },
  errorTitle: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.red,
  },
  errorDetail: {
    fontSize: typography.sm,
    color: colors.muted,
    lineHeight: 18,
  },
  retryBtn: {
    alignSelf: 'flex-start',
    backgroundColor: `${colors.red}15`,
    borderWidth: 1,
    borderColor: `${colors.red}30`,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  retryBtnText: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    color: colors.red,
  },

  // Display — Summary
  summaryCard: {
    backgroundColor: `${colors.purple}08`,
    borderWidth: 1,
    borderColor: `${colors.purple}20`,
    borderRadius: radius.sm,
    padding: spacing.md,
    gap: spacing.sm,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  summaryLabel: {
    fontSize: typography.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: colors.purple,
    fontWeight: typography.semibold,
    flex: 1,
  },
  likelihoodBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
  },
  likelihoodText: {
    fontSize: 9,
    fontWeight: typography.bold,
    letterSpacing: 0.5,
  },
  summaryText: {
    fontSize: typography.base,
    color: colors.text,
    lineHeight: 20,
  },

  // Display — Findings
  findingsContainer: {
    gap: spacing.sm,
  },
  subsectionTitle: {
    fontSize: typography.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: colors.muted,
    fontWeight: typography.semibold,
    marginBottom: 2,
  },
  findingRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  findingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
  },
  findingBody: {
    flex: 1,
    gap: 2,
  },
  findingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  findingMetric: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    color: colors.text,
  },
  findingStatus: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  findingDetail: {
    fontSize: typography.sm,
    color: colors.muted,
    lineHeight: 17,
  },

  // Display — Impression
  impressionContainer: {
    gap: spacing.xs,
  },
  impressionText: {
    fontSize: typography.sm,
    color: colors.text,
    lineHeight: 19,
  },

  // Display — Recommendations
  recsContainer: {
    gap: spacing.xs,
  },
  recRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  recBullet: {
    fontSize: typography.sm,
    color: colors.purple,
    marginTop: 1,
  },
  recText: {
    fontSize: typography.sm,
    color: colors.text,
    flex: 1,
    lineHeight: 18,
  },

  // Display — ICD-10
  icdContainer: {
    gap: spacing.xs,
  },
  icdRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  icdCode: {
    fontFamily: 'monospace',
    fontSize: typography.sm,
    color: colors.cyan,
    fontWeight: typography.semibold,
    minWidth: 50,
  },
  icdDesc: {
    fontSize: typography.sm,
    color: colors.muted,
    flex: 1,
  },

  // Disclaimer
  disclaimerContainer: {
    backgroundColor: `${colors.yellow}08`,
    borderWidth: 1,
    borderColor: `${colors.yellow}20`,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  disclaimerText: {
    fontSize: typography.xs,
    color: colors.yellow,
    lineHeight: 16,
    textAlign: 'center',
  },

  // Regenerate
  regenerateBtn: {
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  regenerateBtnText: {
    fontSize: typography.sm,
    color: colors.purple,
    fontWeight: typography.medium,
  },
});
