import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tool 1: check_normal_ranges
// ---------------------------------------------------------------------------
const checkNormalRanges = tool({
  name: 'check_normal_ranges',
  description:
    'Check whether a hydrocephalus morphometric value falls within normal, borderline, or abnormal ranges. Supports evans_index, callosal_angle, and ventricle_volume.',
  inputSchema: z.object({
    metric: z.enum(['evans_index', 'callosal_angle', 'ventricle_volume']),
    value: z.number(),
  }),
  async execute({ metric, value }) {
    const thresholds = {
      evans_index: {
        normalRange: '< 0.3',
        classify(v) {
          if (v < 0.3) return 'normal';
          if (v <= 0.32) return 'borderline';
          return 'abnormal';
        },
        interpret(status, v) {
          if (status === 'normal')
            return `Evans Index of ${v} is within the normal range (< 0.3), indicating no significant ventricular enlargement.`;
          if (status === 'borderline')
            return `Evans Index of ${v} is borderline (0.3-0.32). Consider clinical correlation and follow-up imaging.`;
          return `Evans Index of ${v} is abnormal (> 0.32), suggesting ventriculomegaly. Further evaluation for hydrocephalus is recommended.`;
        },
      },
      callosal_angle: {
        normalRange: '> 120 degrees',
        classify(v) {
          if (v > 120) return 'normal';
          if (v >= 90) return 'borderline';
          return 'abnormal';
        },
        interpret(status, v) {
          if (status === 'normal')
            return `Callosal angle of ${v} degrees is normal (> 120 degrees), not suggestive of NPH.`;
          if (status === 'borderline')
            return `Callosal angle of ${v} degrees is borderline (90-120 degrees). Clinical correlation is advised.`;
          return `Callosal angle of ${v} degrees is abnormal (< 90 degrees), consistent with upward bowing of the corpus callosum seen in NPH.`;
        },
      },
      ventricle_volume: {
        normalRange: '< 30 mL',
        classify(v) {
          if (v < 30) return 'normal';
          if (v <= 50) return 'borderline';
          return 'abnormal';
        },
        interpret(status, v) {
          if (status === 'normal')
            return `Ventricle volume of ${v} mL is within normal limits (< 30 mL).`;
          if (status === 'borderline')
            return `Ventricle volume of ${v} mL is borderline (30-50 mL). Monitor for progression.`;
          return `Ventricle volume of ${v} mL is abnormal (> 50 mL), indicating significant ventriculomegaly.`;
        },
      },
    };

    const t = thresholds[metric];
    const status = t.classify(value);
    const interpretation = t.interpret(status, value);

    return JSON.stringify({
      metric,
      value,
      status,
      normalRange: t.normalRange,
      interpretation,
    });
  },
});

// ---------------------------------------------------------------------------
// Tool 2: get_icd10_codes
// ---------------------------------------------------------------------------
const getIcd10Codes = tool({
  name: 'get_icd10_codes',
  description:
    'Look up ICD-10 codes for hydrocephalus-related conditions. Accepts conditions such as hydrocephalus, nph, normal_pressure_hydrocephalus, obstructive_hydrocephalus, and ventriculomegaly.',
  inputSchema: z.object({
    condition: z.string(),
  }),
  async execute({ condition }) {
    const lookup = {
      hydrocephalus: {
        icd10Code: 'G91.9',
        description: 'Hydrocephalus, unspecified',
      },
      nph: {
        icd10Code: 'G91.2',
        description: 'Normal pressure hydrocephalus (idiopathic)',
      },
      normal_pressure_hydrocephalus: {
        icd10Code: 'G91.2',
        description: 'Normal pressure hydrocephalus (idiopathic)',
      },
      obstructive_hydrocephalus: {
        icd10Code: 'G91.1',
        description: 'Obstructive hydrocephalus',
      },
      ventriculomegaly: {
        icd10Code: 'Q03.9',
        description: 'Congenital hydrocephalus, unspecified (ventriculomegaly)',
      },
    };

    const key = condition.toLowerCase().trim().replace(/\s+/g, '_');
    const match = lookup[key];

    if (match) {
      return JSON.stringify({
        condition,
        icd10Code: match.icd10Code,
        description: match.description,
      });
    }

    return JSON.stringify({
      condition,
      icd10Code: null,
      description: 'No matching ICD-10 code found',
    });
  },
});

// ---------------------------------------------------------------------------
// Tool 3: get_clinical_guidelines
// ---------------------------------------------------------------------------
const getClinicalGuidelines = tool({
  name: 'get_clinical_guidelines',
  description:
    'Retrieve evidence-based clinical guideline summaries for NPH diagnosis, shunt criteria, or monitoring protocols.',
  inputSchema: z.object({
    topic: z.enum(['nph_diagnosis', 'shunt_criteria', 'monitoring']),
  }),
  async execute({ topic }) {
    const guidelines = {
      nph_diagnosis: {
        guidelines: [
          'Classic Hakim-Adams triad: gait disturbance (magnetic gait), cognitive impairment (dementia), and urinary incontinence.',
          'Imaging criteria: Evans Index > 0.3, callosal angle < 90 degrees, disproportionately enlarged subarachnoid space hydrocephalus (DESH) pattern.',
          'CSF tap test (large-volume lumbar puncture of 30-50 mL): improvement in gait within 24-72 hours supports NPH diagnosis.',
          'Opening pressure is typically normal or mildly elevated (< 24 cm H2O).',
          'MRI may show periventricular signal changes and aqueductal flow void sign.',
        ],
        references: [
          'Relkin N, et al. Diagnosing idiopathic normal-pressure hydrocephalus. Neurosurgery. 2005;57(3 Suppl):S4-16.',
          'Mori E, et al. Guidelines for management of idiopathic normal pressure hydrocephalus: second edition. Neurol Med Chir (Tokyo). 2012;52(11):775-809.',
          'Williams MA, Malm J. Diagnosis and Treatment of Idiopathic Normal Pressure Hydrocephalus. Continuum. 2016;22(2):579-599.',
        ],
      },
      shunt_criteria: {
        guidelines: [
          'Evans Index > 0.3 on axial CT or MRI.',
          'At least one component of the clinical triad: gait disturbance, cognitive decline, or urinary incontinence.',
          'Positive CSF tap test (improvement in gait speed, stride length, or cognitive scores post-drainage).',
          'Extended lumbar drainage (ELD) over 72 hours may increase diagnostic sensitivity.',
          'Consider patient age, comorbidities, and surgical risk in shared decision-making.',
          'Programmable valves preferred to allow post-operative pressure adjustment.',
        ],
        references: [
          'Halperin JJ, et al. Practice guideline: Idiopathic normal pressure hydrocephalus. Neurology. 2015;85(15):1312-1317.',
          'Toma AK, et al. Systematic review of the outcome of shunt surgery in idiopathic normal-pressure hydrocephalus. Acta Neurochir. 2013;155(10):1977-1980.',
        ],
      },
      monitoring: {
        guidelines: [
          'Baseline CT or MRI at time of diagnosis for volumetric reference.',
          'Follow-up imaging at 3-6 months post-shunt to assess ventricular size reduction.',
          'Annual imaging thereafter or sooner if clinical deterioration occurs.',
          'Clinical assessment (gait analysis, MMSE/MoCA, bladder diary) at each follow-up.',
          'Monitor for shunt complications: over-drainage (subdural collections), infection, obstruction.',
          'Programmable valve settings should be checked after any MRI.',
        ],
        references: [
          'Espay AJ, et al. Deconstructing normal pressure hydrocephalus: Ventriculomegaly as early sign of neurodegeneration. Ann Neurol. 2017;82(4):503-513.',
          'Klinge P, et al. One-year outcome in the European multicentre study on iNPH. Acta Neurol Scand. 2012;126(3):145-153.',
        ],
      },
    };

    const g = guidelines[topic];

    return JSON.stringify({
      topic,
      guidelines: g.guidelines,
      references: g.references,
    });
  },
});

// ---------------------------------------------------------------------------
// Tool 4: compare_models
// ---------------------------------------------------------------------------
const compareModels = tool({
  name: 'compare_models',
  description:
    'Compare morphometric results across multiple segmentation models. Computes agreement metrics, maximum deviations, and consensus assessment.',
  inputSchema: z.object({
    modelResults: z.array(
      z.object({
        modelName: z.string(),
        evansIndex: z.number(),
        callosalAngle: z.number(),
        ventVolMl: z.number(),
      })
    ),
  }),
  async execute({ modelResults }) {
    if (modelResults.length < 2) {
      return JSON.stringify({
        agreement: 'insufficient_data',
        deviations: null,
        consensus: 'At least two model results are required for comparison.',
      });
    }

    // Compute min/max for each metric
    const metrics = ['evansIndex', 'callosalAngle', 'ventVolMl'];
    const deviations = {};

    for (const metric of metrics) {
      const values = modelResults.map((r) => r[metric]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const maxDeviation = max - min;

      deviations[metric] = {
        min: Number(min.toFixed(4)),
        max: Number(max.toFixed(4)),
        mean: Number(mean.toFixed(4)),
        maxDeviation: Number(maxDeviation.toFixed(4)),
        models: modelResults.map((r) => ({
          modelName: r.modelName,
          value: r[metric],
        })),
      };
    }

    // Determine agreement level
    const evansDeviation = deviations.evansIndex.maxDeviation;
    const angleDeviation = deviations.callosalAngle.maxDeviation;
    const volumeDeviation = deviations.ventVolMl.maxDeviation;

    // Agreement thresholds
    const highAgreement =
      evansDeviation < 0.02 && angleDeviation < 10 && volumeDeviation < 5;
    const moderateAgreement =
      evansDeviation < 0.05 && angleDeviation < 20 && volumeDeviation < 15;

    let agreement;
    let consensus;

    if (highAgreement) {
      agreement = 'high';
      consensus =
        'Models show strong agreement across all metrics. Results are highly consistent and reliable.';
    } else if (moderateAgreement) {
      agreement = 'moderate';
      consensus =
        'Models show moderate agreement. Some variation exists between segmentation approaches. Consider using the mean values for clinical assessment.';
    } else {
      agreement = 'low';
      consensus =
        'Models show significant disagreement. Manual review of segmentations is recommended. Differences may indicate challenging anatomy or imaging artifacts.';
    }

    // Check if models agree on clinical classification (Evans > 0.3)
    const evansClassifications = modelResults.map((r) => r.evansIndex > 0.3);
    const allAgreeOnEvans = evansClassifications.every(
      (c) => c === evansClassifications[0]
    );

    if (!allAgreeOnEvans) {
      consensus +=
        ' IMPORTANT: Models disagree on whether Evans Index exceeds the 0.3 threshold for ventriculomegaly.';
    }

    return JSON.stringify({
      agreement,
      deviations,
      consensus,
    });
  },
});

// ---------------------------------------------------------------------------
// Export MCP Server
// ---------------------------------------------------------------------------
export const medicalToolServer = createSdkMcpServer({
  name: 'medical-tools',
  tools: [checkNormalRanges, getIcd10Codes, getClinicalGuidelines, compareModels],
});
