/**
 * Shared renderers for the labeled text sections emitted by get_transcript
 * and understand_transcript. Databricks AI Playground reads only
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

export interface SpeechUnderstandingResponse {
  translation?: { status?: string };
  speaker_identification?: { status?: string; mapping?: Record<string, string> };
  custom_formatting?: { status?: string; formatted_text?: string; mapping?: Record<string, string> };
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

export function renderSpeakerIdentification(mapping: Record<string, string>): string[] {
  const lines = ["", "--- speaker_identification (diarization label → identified speaker) ---"];
  for (const [label, who] of Object.entries(mapping)) lines.push(`${label} → ${who}`);
  return lines;
}

export function renderCustomFormatting(formattedText: string): string[] {
  return ["", "--- custom_formatting (transcript with requested formats applied) ---", formattedText];
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

/** Renders every present feature of a speech_understanding.response object. */
export function renderSpeechUnderstanding(response: SpeechUnderstandingResponse): string[] {
  const lines: string[] = [];
  if (response.speaker_identification?.mapping && Object.keys(response.speaker_identification.mapping).length > 0) {
    lines.push(...renderSpeakerIdentification(response.speaker_identification.mapping));
  }
  if (response.custom_formatting?.formatted_text) {
    lines.push(...renderCustomFormatting(response.custom_formatting.formatted_text));
  }
  if (response.summarization?.summary && response.summarization.summary.length > 0) {
    lines.push(...renderSuSummary(response.summarization.summary));
  }
  if (response.action_items?.items && response.action_items.items.length > 0) {
    lines.push(...renderActionItems(response.action_items.items));
  }
  return lines;
}

export function renderContentSafety(labels: ContentSafetyLabels): string[] {
  const lines = ["", "--- content_safety (label: confidence 0–1) ---"];
  for (const [label, confidence] of Object.entries(labels.summary ?? {})) {
    const sev = labels.severity_score_summary?.[label];
    const sevText = sev
      ? ` (severity low=${sev.low ?? 0} medium=${sev.medium ?? 0} high=${sev.high ?? 0})`
      : "";
    lines.push(`${label}: ${confidence.toFixed(2)}${sevText}`);
  }
  return lines;
}

export function renderTopics(result: IabCategoriesResult): string[] {
  const lines = ["", "--- topics (IAB categories; relevance 0–1; top 10) ---"];
  const entries = Object.entries(result.summary ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [topic, relevance] of entries) lines.push(`${topic}: ${relevance.toFixed(2)}`);
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
