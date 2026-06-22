import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5-mini";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function get(obj, pathList) {
  for (const path of pathList) {
    const value = path.split(".").reduce((acc, key) => acc?.[key], obj);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const cleaned = value
      .trim()
      .replace(/,/g, "")
      .replace(/\s*Gt\s*$/i, "")
      .replace(/\s*%\s*$/i, "");

    const normal = Number(cleaned);
    if (Number.isFinite(normal)) return normal;

    const sci = cleaned.match(/^([+-]?\d+(?:\.\d+)?)\s*[×x]\s*10\^?([+-]?\d+)$/i);
    if (sci) return Number(sci[1]) * Math.pow(10, Number(sci[2]));
  }

  return null;
}

function getNumber(obj, paths) {
  return toNumber(get(obj, paths));
}

function getString(obj, paths) {
  const value = get(obj, paths);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getSbtiDelta(payload) {
  return getNumber(payload, [
    "sbtiMilestone.sbtiDeltaPercent",
    "sbtiMilestone.deltaPercent",
    "sbti.deltaPercent",
    "sbtiDeltaPercent",
    "sbtiGapPercent"
  ]);
}

function getSbtiStatus(payload) {
  const status = getString(payload, [
    "sbtiMilestone.status",
    "sbtiMilestone.position",
    "sbti.status"
  ]);

  if (status) {
    const s = status.toLowerCase();
    if (s.includes("ahead")) return "ahead";
    if (s.includes("behind")) return "behind";
    if (s.includes("track") || s.includes("meet")) return "on-track";
  }

  const delta = getSbtiDelta(payload);
  if (typeof delta !== "number") return "unknown";
  if (delta > 0) return "ahead";
  if (delta < 0) return "behind";
  return "on-track";
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "Payload must be a JSON object." };
  }

  if (JSON.stringify(payload).length > 45000) {
    return { ok: false, message: "Payload is too large." };
  }

  const organisation = getString(payload, ["organisation", "organization"]);
  const milestoneYear = String(get(payload, ["milestoneYear", "targetYear"]) || "");
  const segment = get(payload, ["segment"]);

  const readinessIndex = getNumber(payload, [
    "readiness.index",
    "readiness.readinessIndex",
    "overall.readinessIndex"
  ]);

  const maturity = getString(payload, [
    "readiness.maturity",
    "overall.maturity"
  ]);

  const environmentalScore = getNumber(payload, [
    "readiness.environmentalScore",
    "readiness.pillars.environmental",
    "readiness.pillarScores.environmental",
    "esgScores.environmental"
  ]);

  const socialScore = getNumber(payload, [
    "readiness.socialScore",
    "readiness.pillars.social",
    "readiness.pillarScores.social",
    "esgScores.social"
  ]);

  const governanceScore = getNumber(payload, [
    "readiness.governanceScore",
    "readiness.pillars.governance",
    "readiness.pillarScores.governance",
    "esgScores.governance"
  ]);

  const netEmissions = getNumber(payload, [
    "emissions.netEmissionsTco2e",
    "emissions.netEmissions",
    "emissions.net"
  ]);

  const carbonGt = getNumber(payload, [
    "emissions.carbonGt",
    "emissions.intensityGt",
    "emissions.carbonIntensityGt"
  ]);

  const sbtiDelta = getSbtiDelta(payload);

  const energyRatio = getNumber(payload, [
    "energy.energyTransitionRatioPercent",
    "energy.transitionRatioPercent",
    "energy.energyRatio",
    "technicalValidation.energyRatio"
  ]);

  if (!organisation) return { ok: false, message: "Missing organisation." };
  if (!segment) return { ok: false, message: "Missing aerospace segment." };
  if (!["2030", "2035", "2040", "2050"].includes(milestoneYear)) {
    return { ok: false, message: "Invalid milestone year." };
  }

  const checks = [
    ["readiness index", readinessIndex, 0, 100],
    ["environmental score", environmentalScore, 0, 100],
    ["social score", socialScore, 0, 100],
    ["governance score", governanceScore, 0, 100],
    ["net emissions", netEmissions, 0, Infinity],
    ["carbon Gt", carbonGt, 0, Infinity],
    ["SBTi delta", sbtiDelta, -Infinity, Infinity],
    ["MJ energy ratio", energyRatio, 0, Infinity]
  ];

  for (const [name, value, min, max] of checks) {
    if (typeof value !== "number" || value < min || value > max) {
      return { ok: false, message: `Invalid ${name}.` };
    }
  }

  if (!maturity) return { ok: false, message: "Missing maturity rating." };

  return {
    ok: true,
    data: {
      organisation,
      milestoneYear,
      segmentLabel:
        typeof segment === "string"
          ? segment
          : segment.label || segment.code || "Selected aerospace segment",
      readinessIndex,
      maturity,
      environmentalScore,
      socialScore,
      governanceScore,
      netEmissions,
      carbonGt,
      sbtiDelta,
      sbtiStatus: getSbtiStatus(payload),
      energyRatio
    }
  };
}

function extractJson(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI response was not valid JSON.");

  return JSON.parse(match[0]);
}

function normalizeOutput(data) {
  const strategicInterpretation =
    typeof data.strategicInterpretation === "string"
      ? data.strategicInterpretation
      : typeof data.judgeExplanation === "string"
        ? data.judgeExplanation
        : "The AI advisor interprets deterministic ESG outputs into transition guidance.";

  const roadmap = Array.isArray(data.roadmap) ? data.roadmap : [];

  const cleanRoadmap = roadmap.slice(0, 3).map((item, index) => {
    if (typeof item === "string") {
      return {
        phase: ["0-6 months", "6-12 months", "12-24 months"][index],
        action: item
      };
    }

    return {
      phase: item?.phase || ["0-6 months", "6-12 months", "12-24 months"][index],
      action: item?.action || "Strengthen ESG controls, evidence quality, and transition management."
    };
  });

  while (cleanRoadmap.length < 3) {
    cleanRoadmap.push({
      phase: ["0-6 months", "6-12 months", "12-24 months"][cleanRoadmap.length],
      action: "Strengthen ESG ownership, evidence quality, and transition management."
    });
  }

  return {
    executiveSummary:
      typeof data.executiveSummary === "string"
        ? data.executiveSummary
        : "No executive summary returned.",

    topGaps:
      Array.isArray(data.topGaps)
        ? data.topGaps.map(String).filter(Boolean).slice(0, 4)
        : [],

    roadmap: cleanRoadmap,

    policyAlignment:
      Array.isArray(data.policyAlignment)
        ? data.policyAlignment.map(String).filter(Boolean).slice(0, 4)
        : [],

    strategicInterpretation,
    judgeExplanation: strategicInterpretation
  };
}

function hasWrongPositiveSbtiLanguage(output) {
  const text = JSON.stringify(output).toLowerCase();

  return [
    "sbti gap",
    "behind the selected",
    "behind milestone",
    "shortfall",
    "insufficient decarbonisation",
    "insufficient decarbonization",
    "decarbonisation gap",
    "decarbonization gap",
    "below the milestone"
  ].some((phrase) => text.includes(phrase));
}

function buildFallback(payload, v, reason = "Safe fallback used.") {
  const weakest =
    getString(payload, ["readiness.weakestPillar", "diagnostics.primaryConstraint"]) ||
    (v.governanceScore <= v.socialScore && v.governanceScore <= v.environmentalScore
      ? "Governance"
      : v.socialScore <= v.environmentalScore
        ? "Social"
        : "Environmental");

  const sbtiSentence =
    v.sbtiStatus === "ahead"
      ? `ahead of the selected ${v.milestoneYear} SBTi milestone by ${Math.abs(v.sbtiDelta).toFixed(1)} percentage points`
      : v.sbtiStatus === "behind"
        ? `behind the selected ${v.milestoneYear} SBTi milestone by ${Math.abs(v.sbtiDelta).toFixed(1)} percentage points`
        : `on track against the selected ${v.milestoneYear} SBTi milestone`;

  return {
    executiveSummary:
      `${v.organisation} is at ${v.maturity} readiness with a ${v.readinessIndex}/100 index for the ${v.segmentLabel} segment. ` +
      `The organisation is ${sbtiSentence}. The main readiness constraint is ${weakest}, so the priority is improving ESG controls, evidence quality, and repeatable transition management.`,

    topGaps: [
      `${weakest}: this is the main readiness constraint based on deterministic E/S/G scoring.`,
      "Evidence control: improve documentation, role ownership, review cadence, and audit trail.",
      "Social and workforce readiness: strengthen labour disclosure, training records, competency evidence, and transition planning."
    ],

    roadmap: [
      {
        phase: "0-6 months",
        action: `Assign formal ESG ownership for ${v.segmentLabel}, define reporting roles, and create a simple evidence register for emissions, labour, energy, and governance data.`
      },
      {
        phase: "6-12 months",
        action: "Formalise policy controls, management review cadence, training records, labour disclosure evidence, and internal ESG action tracking."
      },
      {
        phase: "12-24 months",
        action: "Embed ESG into operational governance, supplier or workforce planning, and recurring audit-ready reporting while sustaining direct abatement."
      }
    ],

    policyAlignment: [
      "MITI i-ESG Phase 1: strengthen disclosure readiness, governance integration, and capacity building.",
      "NIMP2030 Mission 3: support industrial decarbonisation and higher-value sustainable aerospace operations.",
      "NETR: continue energy transition through renewable energy, bioenergy, hydrogen, and efficiency levers.",
      "National Net-Zero 2050: maintain direct abatement as the priority pathway, with offsets as secondary support."
    ],

    strategicInterpretation:
      `${reason} The deterministic calculator remains the source of truth. The AI layer should interpret results only. ` +
      `SBTi delta is directional: positive means ahead, zero means on track, and negative means behind. ` +
      `The final readiness index is capped by the weakest weighted ESG pillars, not emissions alone.`,

    judgeExplanation:
      `${reason} The deterministic calculator remains the source of truth. The AI layer should interpret results only.`
  };
}

function repairIfNeeded(output, payload, v) {
  const clean = normalizeOutput(output);

  if (v.sbtiStatus === "ahead" && v.sbtiDelta >= 0 && hasWrongPositiveSbtiLanguage(clean)) {
    return buildFallback(
      payload,
      v,
      "Consistency guard applied because the AI described a positive SBTi delta incorrectly."
    );
  }

  const policyText = clean.policyAlignment.join(" ").toLowerCase();

  const required = [
    ["MITI i-ESG Phase 1", "miti"],
    ["NIMP2030 Mission 3", "nimp"],
    ["NETR", "netr"],
    ["National Net-Zero 2050", "net-zero"]
  ];

  for (const [label, key] of required) {
    if (!policyText.includes(key)) {
      clean.policyAlignment.push(`${label}: used as policy-alignment framing, not official certification.`);
    }
  }

  clean.policyAlignment = clean.policyAlignment.slice(0, 4);
  clean.judgeExplanation = clean.strategicInterpretation;

  return clean;
}

const DEVELOPER_PROMPT = `
You are an Aerospace ESG Transformation Advisor for the NAICO ESG Aerospace Validator 2026.

The deterministic calculator is the source of truth.
You only interpret the results.

Domain boundary:
- This endpoint only supports NAICO ESG Aerospace Validator assessment payloads.
- Do not answer general questions.
- Do not provide unrelated advice.

Critical rules:
1. Do not recalculate scores, emissions, Gt, MJ, SBTi delta, maturity, or segment weights.
2. Use only the values provided in the payload.
3. Never invent emission factors, target percentages, standards, policies, or certification claims.
4. Positive SBTi delta means ahead of the selected milestone.
5. Zero SBTi delta means on track.
6. Negative SBTi delta means behind the selected milestone.
7. Never call a positive SBTi delta a gap, weakness, shortfall, or insufficient decarbonisation.
8. Identify gaps from the weakest E/S/G pillars, detected gaps, and displayed result summary.
9. If environmental performance is strong but governance is weak, say readiness is capped by governance maturity.
10. Mention MITI i-ESG, NIMP2030, NETR, and National Net-Zero 2050 only as policy-alignment framing.
11. Keep output concise, practical, executive-level, and suitable for aerospace SMEs.

Return JSON only. No markdown.

Use this exact shape:
{
  "executiveSummary": "string",
  "topGaps": ["string", "string", "string"],
  "roadmap": [
    { "phase": "0-6 months", "action": "string" },
    { "phase": "6-12 months", "action": "string" },
    { "phase": "12-24 months", "action": "string" }
  ],
  "policyAlignment": ["string", "string", "string", "string"],
  "strategicInterpretation": "string"
}
`;

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      message: "Use POST with a NAICO ESG Aerospace Validator assessment payload."
    });
  }

  const validation = validatePayload(req.body || {});

  if (!validation.ok) {
    return res.status(400).json({
      error: "Invalid ESG assessment payload",
      message: validation.message
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY",
      message: "Set OPENAI_API_KEY in Vercel Environment Variables."
    });
  }

  const payload = req.body;
  const v = validation.data;

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const response = await openai.responses.create({
      model: MODEL,
      input: [
        {
          role: "developer",
          content: DEVELOPER_PROMPT
        },
        {
          role: "user",
          content:
            "Analyze this NAICO ESG Aerospace Validator payload. " +
            "Use deterministic values as ground truth. Return JSON only.\n\n" +
            JSON.stringify(payload, null, 2)
        }
      ]
    });

    const parsed = extractJson(response.output_text);
    const safe = repairIfNeeded(parsed, payload, v);

    return res.status(200).json(safe);
  } catch (error) {
    console.error("ESG validator error:", error);

    const fallback = buildFallback(
      payload,
      v,
      `Live AI fallback used because the server could not complete the OpenAI call: ${error.message || "unknown error"}.`
    );

    return res.status(200).json({
      ...fallback,
      fallback: true,
      fallbackReason: error.message || "AI advisor failed."
    });
  }
}