/* =========================================================
   LLM provider abstraction.

   Gemini today (free tier), anything tomorrow. The rest of the codebase only
   ever sees `LlmProvider`, so swapping to Claude/OpenAI is one new file plus
   one line in `getProvider()`. Nothing in the pipeline, prompt, or schema
   knows which model it is talking to.
========================================================= */

export type JsonSchema = Record<string, unknown>;

export type LlmUsage = { inputTokens: number; outputTokens: number };

export type LlmProvider = {
  readonly name: string;
  readonly model: string;
  /** Returns parsed JSON conforming to `schema`, plus token usage. */
  generateJson<T>(args: {
    system: string;
    user: string;
    schema: JsonSchema;
    maxOutputTokens?: number;
    temperature?: number;
  }): Promise<{ data: T; usage: LlmUsage; raw: string }>;
};

export class LlmError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/* ---------------------------------------------------------
   Shared helpers
--------------------------------------------------------- */

/**
 * Models sometimes wrap JSON in markdown fences or add a preamble even when
 * asked not to. Salvage rather than fail the whole generation.
 */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }

  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* fall through */
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as T;
    } catch {
      /* fall through */
    }
  }

  throw new LlmError("BAD_JSON", "Model did not return parseable JSON.");
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof LlmError ? e.retryable : false;
      if (!retryable || i === attempts - 1) throw e;
      // Free-tier quota errors want real backoff, not a tight loop.
      const delay = 1500 * Math.pow(2, i) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------
   Gemini
--------------------------------------------------------- */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini's `responseSchema` is an OpenAPI 3.0 subset, not full JSON Schema.
 * It rejects `additionalProperties` and `$ref`, and ignores most validation
 * keywords. Strip anything it can't take so a schema written for the generic
 * interface doesn't 400 here.
 */
function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const ALLOWED = new Set([
    "type", "format", "description", "nullable", "enum",
    "items", "properties", "required", "propertyOrdering",
  ]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
        if (!ALLOWED.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return node;
  };
  return walk(schema) as JsonSchema;
}

export function geminiProvider(apiKey: string, model: string): LlmProvider {
  return {
    name: "gemini",
    model,
    async generateJson<T>({
      system,
      user,
      schema,
      maxOutputTokens = 16384,
      temperature = 0.4,
    }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(schema),
          temperature,
          maxOutputTokens,
        },
        // Educational content about security, biology, history etc. trips the
        // default thresholds constantly. These are the loosest settings the
        // API exposes; anything genuinely unsafe still gets blocked.
        safetySettings: [
          "HARM_CATEGORY_HARASSMENT",
          "HARM_CATEGORY_HATE_SPEECH",
          "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          "HARM_CATEGORY_DANGEROUS_CONTENT",
        ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
      };

      return withRetry(async () => {
        const res = await fetch(
          `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const retryable = res.status === 429 || res.status >= 500;
          throw new LlmError(
            res.status === 429 ? "RATE_LIMITED" : `HTTP_${res.status}`,
            `Gemini ${res.status}: ${detail.slice(0, 400)}`,
            retryable,
          );
        }

        const json = (await res.json()) as any;

        const blockReason = json?.promptFeedback?.blockReason;
        if (blockReason) {
          throw new LlmError("BLOCKED", `Gemini blocked the prompt: ${blockReason}`);
        }

        const candidate = json?.candidates?.[0];
        if (!candidate) throw new LlmError("EMPTY", "Gemini returned no candidates.");
        if (candidate.finishReason === "MAX_TOKENS") {
          throw new LlmError(
            "TRUNCATED",
            "Output hit the token limit — the transcript is likely too long.",
          );
        }

        const text: string = (candidate.content?.parts ?? [])
          .map((p: any) => p?.text ?? "")
          .join("");
        if (!text.trim()) throw new LlmError("EMPTY", "Gemini returned empty text.");

        return {
          data: parseJsonLoose<T>(text),
          usage: {
            inputTokens: json?.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: json?.usageMetadata?.candidatesTokenCount ?? 0,
          },
          raw: text,
        };
      });
    },
  };
}

/* ---------------------------------------------------------
   Selection
--------------------------------------------------------- */

/**
 * Reads env vars set in the Convex dashboard (`npx convex env set ...`).
 *   LLM_PROVIDER   default "gemini"
 *   LLM_MODEL      default "gemini-2.5-flash"
 *   GEMINI_API_KEY required for gemini
 */
export function getProvider(): LlmProvider {
  const provider = process.env.LLM_PROVIDER ?? "gemini";
  const model = process.env.LLM_MODEL ?? "gemini-2.5-flash";

  switch (provider) {
    case "gemini": {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw new LlmError(
          "NO_API_KEY",
          "GEMINI_API_KEY is not set. Run: npx convex env set GEMINI_API_KEY <key>",
        );
      }
      return geminiProvider(key, model);
    }
    default:
      throw new LlmError("UNKNOWN_PROVIDER", `Unsupported LLM_PROVIDER: ${provider}`);
  }
}
