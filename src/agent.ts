/**
 * The Gemini-backed purchasing agent.
 *
 * This is the half of the system that is *supposed* to be fallible. Gemini
 * reads a task and a list of marketplace services, and decides what the agent
 * wants to buy. That decision is genuinely a model's — which means it can be
 * wrong, and it can be manipulated by anything it reads.
 *
 * That is the point. The engine on the other side of this module assumes
 * exactly that. A demo where the "attack" is a hard-coded string proves
 * nothing about a real agent; here the injected instruction goes into a real
 * model, the model really is talked into proposing the payment, and the
 * deterministic gate really does refuse it. The failure being defended against
 * is reproduced rather than simulated.
 *
 * The boundary this file must never cross: **the model chooses what the agent
 * wants; it never decides whether the agent may have it.** Its output schema
 * cannot express an authorization — there is no `approved` field, no priority,
 * no amount it controls. It names a service and says why. Everything after
 * that is arithmetic over the operator's mandates.
 *
 * Required by the competition: *"Projects that include LLM functionality must
 * use the Gemini API for at least one LLM call in the deployed application."*
 * This is that call, and it sits on the critical path of the product rather
 * than being bolted on to satisfy a rule.
 */

import { GoogleGenAI, Type } from '@google/genai';

/** A service as published on the Circle Agent Marketplace. */
export interface ServiceListing {
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly priceUsdc: string;
}

export interface PurchaseProposal {
  /** The service the model chose, or null when it judged none suitable. */
  readonly serviceUrl: string | null;
  /** The model's stated reason — for the human reading the queue, never for the engine. */
  readonly rationale: string;
  /** True when no model was reachable and the deterministic fallback ran. */
  readonly fallback: boolean;
  readonly model: string;
}

export const DEFAULT_MODEL = process.env['LLM_MODEL'] ?? 'gemini-3-flash-preview';

/**
 * Structured output, so the model returns a choice rather than prose we have
 * to parse. Note what the schema does *not* contain: any field that could
 * authorize a payment. The model's entire influence is which URL it names.
 */
const PROPOSAL_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    serviceUrl: {
      type: Type.STRING,
      description: 'The exact url of the single best service for the task, or "none".',
    },
    rationale: {
      type: Type.STRING,
      description: 'One sentence on why this service fits the task.',
    },
  },
  required: ['serviceUrl', 'rationale'],
} as const;

const SYSTEM_INSTRUCTION = [
  'You are a purchasing agent for a delivery-logistics business.',
  'You are given a task and a list of paid API services from a marketplace.',
  'Choose the single service that best accomplishes the task, and say why in one sentence.',
  'Return the service url exactly as given, or "none" if nothing fits.',
].join(' ');

export interface AgentOptions {
  apiKey?: string;
  model?: string;
}

export class PurchasingAgent {
  private readonly client: GoogleGenAI | null;
  private readonly model: string;

  constructor(options: AgentOptions = {}) {
    const apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'] ?? process.env['GEMINI_API_KEY'];
    this.model = options.model ?? DEFAULT_MODEL;
    // No key is a degraded mode, not a crash: the console has to stay usable
    // for a judge even if a key expires mid-judging-period. Which path ran is
    // reported honestly in `fallback` rather than hidden.
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  get isLive(): boolean {
    return this.client !== null;
  }

  /**
   * Ask Gemini which service to buy.
   *
   * The listings are attacker-influenced input — a marketplace description is
   * text someone else wrote — and they are passed to the model verbatim,
   * because sanitizing them here would hide the very failure this system
   * exists to contain. The containment happens downstream, in code that does
   * not read them.
   */
  async propose(task: string, listings: ServiceListing[]): Promise<PurchaseProposal> {
    if (!this.client) {
      return { ...this.fallbackProposal(task, listings), fallback: true, model: 'none' };
    }

    const catalogue = listings
      .map((l) => `- url: ${l.url}\n  name: ${l.name}\n  price: ${l.priceUsdc} USDC\n  description: ${l.description}`)
      .join('\n');

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: `Task: ${task}\n\nAvailable services:\n${catalogue}`,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: PROPOSAL_SCHEMA,
          // Deterministic enough to demo repeatably, without pretending the
          // model is a lookup table.
          temperature: 0,
        },
      });

      const parsed = JSON.parse(response.text ?? '{}') as { serviceUrl?: string; rationale?: string };
      const chosen = parsed.serviceUrl && parsed.serviceUrl !== 'none' ? parsed.serviceUrl : null;
      return {
        serviceUrl: chosen,
        rationale: parsed.rationale ?? '',
        fallback: false,
        model: this.model,
      };
    } catch (error) {
      // A model outage must not become a payment outage in either direction:
      // it neither authorizes anything nor blocks the console from running.
      const message = error instanceof Error ? error.message : String(error);
      const proposal = this.fallbackProposal(task, listings);
      return { ...proposal, rationale: `${proposal.rationale} (model unavailable: ${message})`, fallback: true, model: this.model };
    }
  }

  /**
   * Keyword matching, used only when no model is reachable.
   *
   * Deliberately naive — and notably, just as manipulable as the model, since
   * it picks on description text an attacker also controls. The safety
   * property does not come from either of these being trustworthy.
   */
  private fallbackProposal(task: string, listings: ServiceListing[]): Omit<PurchaseProposal, 'fallback' | 'model'> {
    const words = task.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    let best: ServiceListing | undefined;
    let bestScore = 0;
    for (const listing of listings) {
      const haystack = `${listing.name} ${listing.description}`.toLowerCase();
      const score = words.filter((w) => haystack.includes(w)).length;
      if (score > bestScore) {
        best = listing;
        bestScore = score;
      }
    }
    return {
      serviceUrl: best?.url ?? null,
      rationale: best ? `keyword match on "${best.name}"` : 'no service matched the task',
    };
  }
}
