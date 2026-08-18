/**
 * Shared renderers for the labeled text sections emitted by get_transcript
 * and understand_transcript. some MCP clients read only
 * content[].text, so every feature result must render as plain text here.
 * Section headers are contract (README "Extending the tool surface"): once
 * shipped, never rename or reshape a section — only add new ones.
 */

export interface SuChapter {
  start: number;
  end: number;
  text: string;
  headline: string;
}

export interface SuActionItem {
  action_item: string;
  quote: string;
  timestamp: number;
}

export interface TranslatedUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  translated_texts?: Record<string, string>;
}

export interface SpeechUnderstandingResponse {
  translation?: { status?: string };
  speaker_identification?: { status?: string; mapping?: Record<string, string> };
  custom_formatting?: {
    status?: string;
    formatted_text?: string;
    mapping?: Record<string, string>;
    formatted_utterances?: Array<{ speaker: string; text: string; start: number; end: number }>;
  };
  summarization?: { status?: string; summary_type?: string; effort?: string; summary?: SuChapter[] };
  action_items?: { status?: string; effort?: string; items?: SuActionItem[] };
}

export interface ContentSafetyLabels {
  summary?: Record<string, number>;
  severity_score_summary?: Record<string, { low?: number; medium?: number; high?: number }>;
}

export interface IabCategoriesResult {
  summary?: Record<string, number>;
}

export interface AutoHighlightsResult {
  results?: Array<{ count: number; rank: number; text: string }>;
}

export function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function renderTranslations(translatedTexts: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [lang, text] of Object.entries(translatedTexts)) {
    lines.push("", `--- translation:${lang} ---`, text);
  }
  return lines;
}

/** Per-utterance translations (translation.match_original_utterance=true). */
export function renderTranslatedUtterances(utterances: TranslatedUtterance[]): string[] {
  const withTranslations = utterances.filter(
    (u) => u.translated_texts && Object.keys(u.translated_texts).length > 0
  );
  if (withTranslations.length === 0) return [];
  const lines = ["", "--- translated_utterances (per-speaker; start/end ms from audio start) ---"];
  for (const u of withTranslations) {
    for (const [lang, text] of Object.entries(u.translated_texts!)) {
      lines.push(`[${u.speaker}] ${formatMs(u.start)}–${formatMs(u.end)} ${lang}: ${text}`);
    }
  }
  return lines;
}

export function renderSpeakerIdentification(mapping: Record<string, string>): string[] {
  const lines = ["", "--- speaker_identification (diarization label → identified speaker) ---"];
  for (const [label, who] of Object.entries(mapping)) lines.push(`${label} → ${who}`);
  return lines;
}

export function renderCustomFormatting(formattedText: string): string[] {
  return ["", CUSTOM_FORMATTING_HEADER, formattedText];
}

export function renderSuSummary(chapters: SuChapter[]): string[] {
  const lines = ["", "--- su_summary (chaptered summary; start–end are m:ss) ---"];
  for (const c of chapters) lines.push(`[${formatMs(c.start)}–${formatMs(c.end)}] ${c.headline} — ${c.text}`);
  return lines;
}

export function renderActionItems(items: SuActionItem[]): string[] {
  const lines = ["", "--- action_items ---"];
  for (const i of items) lines.push(`- ${i.action_item} (quote: "${i.quote}" @ ${formatMs(i.timestamp)})`);
  return lines;
}

const CUSTOM_FORMATTING_HEADER = "--- custom_formatting (transcript with requested formats applied) ---";

/**
 * Renders every present feature of a speech_understanding.response object.
 * A feature with a non-"success" status is surfaced as a one-line failure
 * marker (rather than silently dropped) so failed/partial SU runs are still
 * visible to the caller. Mapping-only / empty-but-successful results also
 * render a short note instead of vanishing.
 */
export function renderSpeechUnderstanding(response: SpeechUnderstandingResponse): string[] {
  const lines: string[] = [];
  const featureOrder = [
    "translation",
    "speaker_identification",
    "custom_formatting",
    "summarization",
    "action_items",
  ] as const;

  for (const feature of featureOrder) {
    const result = response[feature];
    if (!result) continue;
    if (result.status !== undefined && result.status !== "success") {
      lines.push("", `(${feature}: ${result.status})`);
      continue;
    }

    switch (feature) {
      case "speaker_identification": {
        const mapping = response.speaker_identification?.mapping;
        if (mapping && Object.keys(mapping).length > 0) {
          lines.push(...renderSpeakerIdentification(mapping));
        }
        break;
      }
      case "custom_formatting": {
        const cf = response.custom_formatting;
        if (cf?.formatted_text) {
          lines.push(...renderCustomFormatting(cf.formatted_text));
          if (cf.formatted_utterances && cf.formatted_utterances.length > 0) {
            for (const u of cf.formatted_utterances) {
              lines.push(`[${u.speaker}] ${formatMs(u.start)}–${formatMs(u.end)}: ${u.text}`);
            }
          }
        } else if (cf?.mapping && Object.keys(cf.mapping).length > 0) {
          lines.push("", CUSTOM_FORMATTING_HEADER);
          for (const [original, formatted] of Object.entries(cf.mapping)) {
            lines.push(`${original} → ${formatted}`);
          }
        }
        break;
      }
      case "summarization": {
        const su = response.summarization;
        if (su?.summary && su.summary.length > 0) {
          lines.push(...renderSuSummary(su.summary));
        } else if (su?.summary) {
          lines.push("", "--- su_summary (chaptered summary; start–end are m:ss) ---", "(no chapters returned)");
        }
        break;
      }
      case "action_items": {
        const ai = response.action_items;
        if (ai?.items && ai.items.length > 0) {
          lines.push(...renderActionItems(ai.items));
        } else if (ai?.items) {
          lines.push("", "--- action_items ---", "(none found)");
        }
        break;
      }
      // translation has no content of its own here — its text is rendered
      // separately via renderTranslations/renderTranslatedUtterances from
      // the top-level translated_texts / utterances fields.
      default:
        break;
    }
  }

  return lines;
}

/** AssemblyAI's response types aren't runtime-validated; guard against a
 * non-number slipping through (would otherwise throw on .toFixed). */
function formatScore(value: unknown): string {
  return typeof value === "number" ? value.toFixed(2) : String(value);
}

export function renderContentSafety(labels: ContentSafetyLabels): string[] {
  const lines = ["", "--- content_safety (label: confidence 0–1) ---"];
  for (const [label, confidence] of Object.entries(labels.summary ?? {})) {
    const sev = labels.severity_score_summary?.[label];
    const sevText = sev
      ? ` (severity low=${formatScore(sev.low ?? 0)} medium=${formatScore(sev.medium ?? 0)} high=${formatScore(sev.high ?? 0)})`
      : "";
    lines.push(`${label}: ${formatScore(confidence)}${sevText}`);
  }
  return lines;
}

export function renderTopics(result: IabCategoriesResult): string[] {
  const lines = ["", "--- topics (IAB categories; relevance 0–1; top 10) ---"];
  const entries = Object.entries(result.summary ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [topic, relevance] of entries) lines.push(`${topic}: ${formatScore(relevance)}`);
  return lines;
}

export function renderHighlights(result: AutoHighlightsResult): string[] {
  const lines = ["", "--- highlights (key phrases; count = occurrences) ---"];
  const results = [...(result.results ?? [])].sort((a, b) => b.rank - a.rank);
  for (const r of results) lines.push(`${r.count}× "${r.text}"`);
  return lines;
}

export function renderUnredactedText(text: string): string[] {
  return ["", "--- unredacted_text (returned because redact_pii_return_unredacted was set) ---", text];
}

export function renderRedactedAudio(url: string): string[] {
  return ["", "--- redacted_audio ---", url, "(link expires ~24 hours after transcription)"];
}

export function renderWarnings(warnings: Array<{ message: string }>): string[] {
  const lines = ["", "--- warnings (processing notes from AssemblyAI) ---"];
  for (const w of warnings) lines.push(`- ${w.message}`);
  return lines;
}
