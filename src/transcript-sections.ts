/** Some MCP clients read only content[].text, so every feature result renders as plain text. */

interface SuChapter {
  start: number;
  end: number;
  text?: string;
  bullets?: string[] | string;
  headline: string;
}

interface SuActionItem {
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
    formatted_utterances?: Array<{
      speaker: string; text: string; start: number; end: number;
      words?: Array<{ text: string; start: number; end: number; confidence: number; speaker: string | null }>;
    }>;
  };
  summarization?: {
    status?: string;
    summary_type?: string;
    effort?: string;
    summary?: SuChapter[];
    block_summary?: string;
  };
  action_items?: { status?: string; effort?: string; items?: SuActionItem[] };
}

export interface ContentSafetyLabels {
  status?: string;
  summary?: Record<string, number>;
  severity_score_summary?: Record<string, { low?: number; medium?: number; high?: number }>;
  results?: Array<{
    text?: string;
    timestamp?: { start?: number; end?: number };
    labels?: Array<{ label: string; confidence: number }>;
  }>;
}

export interface IabCategoriesResult {
  status?: string;
  summary?: Record<string, number>;
}

export interface AutoHighlightsResult {
  status?: string;
  results?: Array<{ count: number; rank: number; text: string; timestamps?: Array<{ start?: number; end?: number }> }>;
}

export function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Add precise evidence without changing the legacy m:ss rendering. API
 * payloads are not runtime-validated, so never fabricate a malformed range. */
export function formatTimestampRange(start: unknown, end: unknown): string | undefined {
  if (typeof start !== "number" || typeof end !== "number" ||
      !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return undefined;
  return `${formatMs(start)}–${formatMs(end)} (start=${start}ms end=${end}ms from audio start)`;
}

export function renderEntityEvidence(entities: Array<{ text: string; entity_type: string; start: number; end: number }>): string[] {
  const evidence: string[] = [];
  for (const e of entities) {
    const range = formatTimestampRange(e.start, e.end);
    if (range) evidence.push(`${e.entity_type}: ${e.text} @ ${range}`);
  }
  return evidence.length ? ["", "--- entity_evidence ---", ...evidence] : [];
}

export function renderContentSafetyEvidence(labels: ContentSafetyLabels): string[] {
  const evidence: string[] = [];
  for (const r of Array.isArray(labels.results) ? labels.results : []) {
    const range = formatTimestampRange(r?.timestamp?.start, r?.timestamp?.end);
    if (!range) continue;
    const categories = (Array.isArray(r.labels) ? r.labels : [])
      .map((label) => `${label.label}: ${formatScore(label.confidence)}`).join(", ");
    evidence.push(`${range}${categories ? ` [${categories}]` : ""}${r.text ? `: ${r.text}` : ""}`);
  }
  return evidence.length ? ["", "--- content_safety_evidence ---", ...evidence] : [];
}

export function renderTranslations(translatedTexts: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [lang, text] of Object.entries(translatedTexts)) {
    lines.push("", `--- translation:${lang} ---`, text);
  }
  return lines;
}

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

function renderSpeakerIdentification(mapping: Record<string, string>): string[] {
  const lines = ["", "--- speaker_identification (diarization label → identified speaker) ---"];
  for (const [label, who] of Object.entries(mapping)) lines.push(`${label} → ${who}`);
  return lines;
}

function renderCustomFormatting(formattedText: string): string[] {
  return ["", CUSTOM_FORMATTING_HEADER, formattedText];
}

export function renderSuSummary(chapters: SuChapter[]): string[] {
  const lines = ["", "--- su_summary (chaptered summary; start–end are m:ss) ---"];
  for (const c of chapters) {
    const head = `[${formatMs(c.start)}–${formatMs(c.end)}] ${c.headline}`;
    const raw = Array.isArray(c.bullets) ? c.bullets : typeof c.bullets === "string" ? [c.bullets] : [];
    const bullets = raw
      .filter((b): b is string => typeof b === "string")
      .flatMap((b) => b.split(/\r?\n/))
      .filter((b) => b.trim() !== "");
    if (bullets.length > 0) {
      lines.push(head);
      // The API may already prefix each bullet with "- " or "• ".
      for (const b of bullets) lines.push(`  - ${b.trim().replace(/^[-•*]\s+/, "")}`);
    } else if (typeof c.text === "string" && c.text !== "") {
      lines.push(`${head} — ${c.text}`);
    } else {
      lines.push(head);
    }
  }
  return lines;
}

function renderActionItems(items: SuActionItem[]): string[] {
  const lines = ["", "--- action_items ---"];
  for (const i of items) lines.push(`- ${i.action_item} (quote: "${i.quote}" @ ${formatMs(i.timestamp)})`);
  return lines;
}

const CUSTOM_FORMATTING_HEADER = "--- custom_formatting (transcript with requested formats applied) ---";

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
        if (su?.block_summary) {
          lines.push("", "--- su_block_summary ---", su.block_summary);
        }
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
      default:
        break;
    }
  }

  return lines;
}

function formatScore(value: unknown): string {
  return typeof value === "number" ? value.toFixed(2) : String(value);
}

export function renderContentSafety(labels: ContentSafetyLabels): string[] {
  if (labels.status !== undefined && labels.status !== "success") {
    return ["", `(content_safety: ${labels.status})`];
  }
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
  if (result.status !== undefined && result.status !== "success") {
    return ["", `(topics: ${result.status})`];
  }
  const lines = ["", "--- topics (IAB categories; relevance 0–1; top 10) ---"];
  const entries = Object.entries(result.summary ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [topic, relevance] of entries) lines.push(`${topic}: ${formatScore(relevance)}`);
  return lines;
}

export function renderHighlights(result: AutoHighlightsResult): string[] {
  if (result.status !== undefined && result.status !== "success") {
    return ["", `(highlights: ${result.status})`];
  }
  const lines = ["", "--- highlights (key phrases; count = occurrences) ---"];
  const results = [...(result.results ?? [])].sort((a, b) => b.rank - a.rank);
  for (const r of results) lines.push(`${r.count}× "${r.text}"`);
  const evidence: string[] = [];
  for (const r of results) {
    for (const timestamp of Array.isArray(r.timestamps) ? r.timestamps : []) {
      const range = formatTimestampRange(timestamp?.start, timestamp?.end);
      if (range) evidence.push(`"${r.text}" @ ${range}`);
    }
  }
  if (evidence.length) lines.push("", "--- highlight_evidence ---", ...evidence);
  return lines;
}

export function renderUnredactedText(text: string): string[] {
  return ["", "--- unredacted_text (returned because redact_pii_return_unredacted was set) ---", text];
}

/** Which PII categories were redacted, and what redaction does not cover. */
export function renderRedaction(policies: string[], hasEntities: boolean): string[] {
  const lines = ["", "--- redaction (PII categories redacted in the text; others are not) ---", policies.join(", ")];
  if (hasEntities) lines.push("(entities are not redacted and may contain PII)");
  return lines;
}

export function renderRedactedAudio(url: string): string[] {
  return ["", "--- redacted_audio ---", url, "(link expires ~24 hours after transcription)"];
}

export function renderWarnings(warnings: Array<{ message: string }>): string[] {
  const lines = ["", "--- warnings (processing notes from AssemblyAI) ---"];
  for (const w of warnings) lines.push(`- ${w.message}`);
  return lines;
}
