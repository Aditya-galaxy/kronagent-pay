/**
 * The campaign agent — the two decisions that are judgment rather than rule.
 *
 * Everything else in this repo is deterministic on purpose. These two are not,
 * and that is the point: *"is this rate right for how the pool is draining"*
 * and *"does this growth pattern look wrong"* are questions no threshold
 * answers well. A rule that cuts the CPM at 70% pool usage is wrong for a
 * campaign that started slowly; a rule that flags any 10x view burst punishes
 * every clip that genuinely went viral.
 *
 * ## Both are structurally incapable of releasing money
 *
 * This is the design property that makes an untrusted model safe here.
 *
 * **The rate proposer** can only suggest a number, which `decideRate` accepts
 * only inside the operator's band and *refuses* rather than clamps outside it.
 * A prompt-injected agent asking for a 50 USDC CPM gets the rate it started
 * with.
 *
 * **The investigator** can only ever say *wait* or *look closer*. It has no
 * verdict that releases a payout — the strongest thing it can return is
 * `hold`, and the gate would have paid without it. An attacker who fully
 * controls the investigator gains the ability to delay their own money.
 *
 * So the worst case for both is a campaign that pays slowly, which is
 * recoverable. Neither can produce the failure that matters.
 */

import { GoogleGenAI, Type } from '@google/genai';

import { decideRate, type RateDecision } from './rate';
import type { CampaignTelemetry, VelocitySignal } from './telemetry';
import type { Campaign } from './types';

export const DEFAULT_AGENT_MODEL = 'gemini-3-flash-preview';

/* ───────────────────────────── rate allocation ───────────────────────────── */

export interface RateProposal {
  readonly proposedUsdc: string;
  readonly rationale: string;
}

export interface RateProposer {
  propose(telemetry: CampaignTelemetry): Promise<RateProposal>;
}

const RATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    proposedUsdc: {
      type: Type.STRING,
      description:
        'The CPM to use from now on, as a decimal string with at most 6 decimal ' +
        'places. Return the current rate unchanged if no change is warranted.',
    },
    rationale: {
      type: Type.STRING,
      description:
        'One or two sentences an operator would accept as a reason, citing the ' +
        'numbers that drove it.',
    },
  },
  required: ['proposedUsdc', 'rationale'],
} as const;

const RATE_INSTRUCTION = `You set the pay rate for a creator marketing campaign.

The rate is USDC per 1,000 views that have survived a dwell window. You are
given the campaign's real telemetry. Decide whether the rate should change.

Raise it when the pool is draining too slowly to be spent by the end date, or
when submissions are scarce — a rate nobody will work for wastes the whole
budget. Lower it when the pool will empty long before the campaign ends, which
strands every creator who posts later.

Prefer no change. A rate that moves constantly is one no creator can plan
against, and every change applies only to clips accepted afterwards — work
already accepted keeps the rate it was accepted under.

You may only propose a rate inside the operator's band. A proposal outside it
is refused outright and the rate stays where it is, so proposing 50 when the
ceiling is 2 achieves nothing.`;

export class GeminiRateProposer implements RateProposer {
  private readonly ai: GoogleGenAI;
  constructor(
    private readonly options: {
      apiKey?: string;
      vertex?: { project: string; location?: string };
      model?: string;
    },
  ) {
    this.ai = options.vertex
      ? new GoogleGenAI({
          vertexai: true,
          project: options.vertex.project,
          location: options.vertex.location ?? 'global',
        })
      : new GoogleGenAI({ apiKey: options.apiKey });
  }

  async propose(telemetry: CampaignTelemetry): Promise<RateProposal> {
    const response = await this.ai.models.generateContent({
      model: this.options.model ?? DEFAULT_AGENT_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: `Campaign telemetry:\n${JSON.stringify(telemetry, null, 2)}` }],
        },
      ],
      config: {
        systemInstruction: RATE_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RATE_SCHEMA,
        temperature: 0,
      },
    });

    const text = response.text?.trim();
    if (!text) throw new Error('the model returned no rate proposal');
    const parsed = JSON.parse(text) as { proposedUsdc?: unknown; rationale?: unknown };
    return {
      proposedUsdc: String(parsed.proposedUsdc ?? telemetry.cpmUsdc),
      rationale: String(parsed.rationale ?? '').slice(0, 500),
    };
  }
}

/**
 * Propose, then let the band decide.
 *
 * Returns the decision rather than applying it, so a caller can record a
 * refused proposal — which is the interesting one. A rate the agent *wanted*
 * and did not get is evidence about the agent.
 */
export async function proposeRateFor(
  campaign: Campaign,
  telemetry: CampaignTelemetry,
  proposer: RateProposer,
  now: Date = new Date(),
): Promise<RateDecision> {
  const proposal = await proposer.propose(telemetry);
  return decideRate(
    campaign,
    { campaignId: campaign.campaignId, proposedUsdc: proposal.proposedUsdc, rationale: proposal.rationale },
    now,
  );
}

/* ─────────────────────────── fraud investigation ─────────────────────────── */

/**
 * What an investigation can conclude.
 *
 * Note what is absent: there is no outcome that pays. `clear` means "I found
 * nothing", and the gate would have paid anyway. The investigator's entire
 * range is between *no effect* and *delay*.
 */
export type Finding = 'clear' | 'watch' | 'hold';

export interface Investigation {
  readonly submissionId: string;
  readonly finding: Finding;
  readonly reasons: string[];
  /** True when the agent wants another data point before concluding. */
  readonly wantsMoreData: boolean;
  readonly model: string;
}

export interface FraudInvestigator {
  investigate(signal: VelocitySignal, context: { dwellHours: number }): Promise<Investigation>;
}

const INVESTIGATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    finding: {
      type: Type.STRING,
      enum: ['clear', 'watch', 'hold'],
      description:
        'clear = nothing unusual. watch = odd but not enough to act on. ' +
        'hold = do not pay this yet.',
    },
    reasons: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Specific, citing the numbers. A creator may read these.',
    },
    wantsMoreData: {
      type: Type.BOOLEAN,
      description: 'True if another view sample would change your conclusion.',
    },
  },
  required: ['finding', 'reasons', 'wantsMoreData'],
} as const;

const INVESTIGATION_INSTRUCTION = `You examine how a clip's view count moved over time and judge
whether the pattern warrants delaying payment.

You are given measurements, not accusations. A sudden burst is genuinely
ambiguous: a clip picked up by the algorithm and a clip bought from a bot farm
produce the same curve. Weigh what you are given rather than applying a
threshold.

Two patterns are worth attention. A count that *fell* means the platform
removed views it judged inauthentic. A burst ratio far above 1 means growth
arrived in one jump rather than accumulating.

Neither is proof. Most viral clips burst. Prefer "clear" unless the pattern is
genuinely hard to explain, and remember the cost asymmetry runs the other way
from usual here: a wrongly held payout delays an honest creator's money and
makes them distrust the platform.

You cannot approve a payment. Your strongest conclusion is "hold", which delays
it. Nothing you return releases money.`;

export class GeminiFraudInvestigator implements FraudInvestigator {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  constructor(
    private readonly options: {
      apiKey?: string;
      vertex?: { project: string; location?: string };
      model?: string;
    },
  ) {
    this.ai = options.vertex
      ? new GoogleGenAI({
          vertexai: true,
          project: options.vertex.project,
          location: options.vertex.location ?? 'global',
        })
      : new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_AGENT_MODEL;
  }

  async investigate(
    signal: VelocitySignal,
    context: { dwellHours: number },
  ): Promise<Investigation> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `Dwell window: ${context.dwellHours}h\n\n` +
                `View history:\n${JSON.stringify(signal, null, 2)}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: INVESTIGATION_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: INVESTIGATION_SCHEMA,
        temperature: 0,
      },
    });

    const text = response.text?.trim();
    if (!text) throw new Error('the model returned no investigation');
    const parsed = JSON.parse(text) as {
      finding?: unknown;
      reasons?: unknown;
      wantsMoreData?: unknown;
    };

    // Anything unrecognised becomes `watch`, not `clear`. An investigation we
    // cannot read should not silently resolve in the submitter's favour — but
    // it must not resolve to `hold` either, or a malformed response becomes a
    // way to freeze an honest creator's money.
    const raw = String(parsed.finding ?? '');
    const finding: Finding = raw === 'clear' || raw === 'hold' ? raw : 'watch';

    return {
      submissionId: signal.submissionId,
      finding,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).filter(Boolean) : [],
      wantsMoreData: parsed.wantsMoreData === true,
      model: this.model,
    };
  }
}

/** Build both from the environment, or neither. */
export function agentFromEnv(env: Record<string, string | undefined> = Bun.env): {
  rate?: RateProposer;
  investigator?: FraudInvestigator;
} {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim();
  const useVertex = env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && project;
  const apiKey = (env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY)?.trim();
  if (!useVertex && !apiKey) return {};

  const options = useVertex
    ? { vertex: { project: project!, location: env.GOOGLE_CLOUD_LOCATION?.trim() || 'global' }, model: env.LLM_MODEL }
    : { apiKey, model: env.LLM_MODEL };

  return {
    rate: new GeminiRateProposer(options),
    investigator: new GeminiFraudInvestigator(options),
  };
}
