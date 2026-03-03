import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { medicalToolServer } from './tools/medicalTools.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the Anthropic API key is configured.
 */
function isAgentAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Build the neuroradiology system prompt for the Claude agent.
 */
function buildSystemPrompt() {
  return `You are a neuroradiology AI assistant. Analyze hydrocephalus morphometrics and provide clinical interpretation.

Use your medical tools to check normal ranges, look up ICD-10 codes, and reference clinical guidelines.

Structure your response as JSON:
{
  "summary": "1-2 sentence clinical summary",
  "findings": [{ "metric": "...", "value": ..., "status": "normal|borderline|abnormal", "detail": "..." }],
  "impression": "Overall clinical impression paragraph",
  "recommendations": ["List of clinical recommendations"],
  "icd10Codes": [{ "code": "...", "description": "..." }],
  "nphLikelihood": "low|moderate|high",
  "disclaimer": "AI-generated interpretation. Not a substitute for professional medical diagnosis."
}

Always output ONLY the JSON object, no markdown fences or extra text.`;
}

/**
 * Build the user message describing the morphometric results.
 */
function buildUserMessage(results) {
  const {
    evansIndex,
    callosalAngle,
    ventVolMl,
    nphScore,
    nphPct,
    processingTime,
    modelName,
    multiModelResults,
  } = results;

  let msg = `Please interpret the following hydrocephalus morphometric results:\n\n`;
  msg += `- Evans Index: ${evansIndex}\n`;
  msg += `- Callosal Angle: ${callosalAngle} degrees\n`;
  msg += `- Ventricle Volume: ${ventVolMl} mL\n`;

  if (nphScore !== undefined) {
    msg += `- NPH Score: ${nphScore}/3\n`;
  }
  if (nphPct !== undefined) {
    msg += `- NPH Probability: ${nphPct}%\n`;
  }
  if (processingTime !== undefined) {
    msg += `- Processing Time: ${processingTime}ms\n`;
  }
  if (modelName) {
    msg += `- Segmentation Model: ${modelName}\n`;
  }

  if (multiModelResults && multiModelResults.length > 1) {
    msg += `\nMulti-model comparison results are available:\n`;
    for (const mr of multiModelResults) {
      msg += `  - ${mr.modelName}: EI=${mr.evansIndex}, CA=${mr.callosalAngle}deg, Vol=${mr.ventVolMl}mL\n`;
    }
    msg += `\nPlease use the compare_models tool to assess inter-model agreement.\n`;
  }

  msg += `\nUse check_normal_ranges for each metric, get_icd10_codes for relevant conditions, and get_clinical_guidelines for applicable guidelines. Return the structured JSON interpretation.`;

  return msg;
}

/**
 * Fallback parser: wrap plain text in the expected response structure when
 * the agent returns unstructured text instead of JSON.
 */
function parseInterpretation(text) {
  // Try to extract JSON from the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      // Ensure disclaimer is always present
      if (!parsed.disclaimer) {
        parsed.disclaimer =
          'AI-generated interpretation. Not a substitute for professional medical diagnosis.';
      }
      return parsed;
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: wrap plain text in expected structure
  return {
    summary: text.slice(0, 200),
    findings: [],
    impression: text,
    recommendations: [
      'Consult a neuroradiology specialist for definitive interpretation.',
    ],
    icd10Codes: [],
    nphLikelihood: 'unknown',
    disclaimer:
      'AI-generated interpretation. Not a substitute for professional medical diagnosis.',
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/health
 * Health check endpoint. Reports whether the agent SDK is configured.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    agentAvailable: isAgentAvailable(),
  });
});

/**
 * POST /api/interpret
 * Main interpretation endpoint. Sends morphometric data to the Claude agent
 * with medical MCP tools and returns a structured clinical interpretation.
 */
app.post('/api/interpret', async (req, res) => {
  // Gate on API key availability
  if (!isAgentAvailable()) {
    return res.status(503).json({
      error: 'Agent unavailable',
      message:
        'ANTHROPIC_API_KEY is not configured. Set it in the server .env file.',
    });
  }

  const { results } = req.body;

  if (!results) {
    return res.status(400).json({
      error: 'Bad request',
      message: 'Request body must include a "results" object.',
    });
  }

  // Enforce request timeout
  const TIMEOUT_MS = 60_000;
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        error: 'Timeout',
        message: `Agent did not respond within ${TIMEOUT_MS / 1000} seconds.`,
      });
    }
  }, TIMEOUT_MS);

  try {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(results);

    let resultText = '';

    for await (const message of query({
      model: 'claude-sonnet-4-20250514',
      systemPrompt,
      prompt: userMessage,
      allowedTools: ['Read'],
      mcpServers: { medical: medicalToolServer },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 10,
    })) {
      if ('result' in message) {
        resultText = message.result;
      }
    }

    clearTimeout(timeoutId);

    if (res.headersSent) return;

    if (!resultText) {
      return res.status(500).json({
        error: 'Empty response',
        message: 'The agent returned no result text.',
      });
    }

    const interpretation = parseInterpretation(resultText);

    return res.json({
      success: true,
      interpretation,
      raw: resultText,
    });
  } catch (err) {
    clearTimeout(timeoutId);

    if (res.headersSent) return;

    console.error('[/api/interpret] Error:', err.message || err);

    return res.status(500).json({
      error: 'Internal server error',
      message: err.message || 'An unexpected error occurred during interpretation.',
    });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`HydroMorph Agent Server running on port ${PORT}`);
  console.log(`Agent available: ${isAgentAvailable()}`);
  console.log(`Health check:    http://localhost:${PORT}/api/health`);
  console.log(`Interpret:       POST http://localhost:${PORT}/api/interpret`);
});
