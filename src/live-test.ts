/**
 * Live end-to-end test: drives the running MCP server over Streamable HTTP
 * with the real MCP SDK client, against the real AssemblyAI API.
 *
 * Unlike `smoke-test.ts` (mocked AssemblyAI, in-process transport), this
 * exercises the full stack: HTTP transport, withMcpAuth Bearer stripping,
 * production transcription, and the LLM Gateway. It costs a few cents of
 * transcription credit per run.
 *
 * Usage:
 *   ASSEMBLYAI_API_KEY=... npm run test:live                 # against http://localhost:3001/mcp
 *   ASSEMBLYAI_API_KEY=... MCP_URL=https://<host>/mcp npm run test:live
 *
 * The key is sent as `Authorization: Bearer <key>` — the shape MCP
 * clients produce — so the auth bridge is tested too.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001/mcp";
const API_KEY = process.env.ASSEMBLYAI_API_KEY;

// Short, public, English samples hosted by AssemblyAI's docs.
const SHORT_CLIP = "https://assembly.ai/sports_injuries.mp3";
const INTERVIEW_CLIP = "https://assembly.ai/wildfires.mp3"; // two speakers, person names
const M4A_CLIP = "https://assembly.ai/new-approved-medication"; // entities, non-mp3 container
const BAD_URL = "https://example.com/does-not-exist.mp3";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

function textOf(r: ToolResult): string {
  return r.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function pollUntilDone(client: Client, transcriptId: string): Promise<ToolResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const r = await callTool(client, "get_transcript", { transcript_id: transcriptId });
    const status = r.structuredContent?.status;
    if (status === "completed" || status === "error") return r;
    if (Date.now() > deadline) throw new Error(`poll timeout for ${transcriptId} (last status=${status})`);
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

async function submitAndPoll(
  client: Client,
  createdIds: string[],
  args: Record<string, unknown>
): Promise<{ id: string; final: ToolResult }> {
  const submitted = await callTool(client, "submit_transcript", args);
  const id = submitted.structuredContent?.transcript_id as string;
  if (!id) throw new Error(`submit returned no transcript_id: ${textOf(submitted)}`);
  // Record the id as soon as it exists — before polling — so teardown can
  // clean it up even if a later assertion throws mid-run.
  createdIds.push(id);
  const final = await pollUntilDone(client, id);
  return { id, final };
}

async function run() {
  if (!API_KEY) {
    console.error("ASSEMBLYAI_API_KEY is required (never hardcode it).");
    process.exit(1);
  }

  console.log(`Running live tests against ${MCP_URL}\n`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const client = new Client({ name: "live-test", version: "0.1.0" });
  await client.connect(transport);

  // 1. Tool discovery
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert(
    "1. tools/list exposes exactly the 5 tools",
    JSON.stringify(names) ===
      JSON.stringify([
        "delete_transcript",
        "get_transcript",
        "submit_transcript",
        "summarize_transcript",
        "understand_transcript",
      ]),
    names.join(", ")
  );

  // Every transcript_id created below is recorded here (by submitAndPoll,
  // immediately after submit succeeds) so the finally block can tear all of
  // them down even if an assertion throws partway through the run — a
  // mid-run failure used to skip teardown entirely and leak transcripts.
  const createdIds: string[] = [];

  try {
    // Submit all scenarios up front so transcriptions run concurrently.
    const [plain, features, entities, pii, understanding, guardrails] = await Promise.all([
      submitAndPoll(client, createdIds, { audio_url: SHORT_CLIP }),
      submitAndPoll(client, createdIds, {
        audio_url: INTERVIEW_CLIP,
        speaker_labels: true,
        sentiment_analysis: true,
      }),
      submitAndPoll(client, createdIds, { audio_url: M4A_CLIP, entity_detection: true }),
      submitAndPoll(client, createdIds, { audio_url: INTERVIEW_CLIP, redact_pii: true }),
      submitAndPoll(client, createdIds, {
        audio_url: INTERVIEW_CLIP,
        speaker_labels: true,
        speech_understanding: {
          request: {
            translation: { target_languages: ["es"] },
            summarization: { summary_type: "bullets" },
          },
        },
      }),
      submitAndPoll(client, createdIds, { audio_url: SHORT_CLIP, filter_profanity: true, content_safety: true }),
    ]);

    // 2. Plain transcription + model pin surfaced
    assert("2. plain transcription completes", plain.final.structuredContent?.status === "completed");
    assert(
      "2. speech_model_used=universal-3-5-pro in structuredContent",
      plain.final.structuredContent?.speech_model_used === "universal-3-5-pro",
      String(plain.final.structuredContent?.speech_model_used)
    );
    assert(
      "2. speech_model_used appears in text payload",
      textOf(plain.final).includes("speech_model_used=universal-3-5-pro")
    );
    assert("2. text section present", textOf(plain.final).includes("--- text ---"));

    // 3. Speaker labels + sentiment. Section headers carry explanatory
    // parentheticals (e.g. "--- utterances (per-speaker segments; ...) ---"),
    // so match on the label prefix only.
    const featText = textOf(features.final);
    assert(
      "3. utterances section with speakers",
      featText.includes("--- utterances") && featText.includes("[A]"),
      featText.slice(0, 200)
    );
    assert(
      "3. sentiment section present",
      featText.includes("--- sentiment") &&
        Array.isArray(features.final.structuredContent?.sentiment)
    );

    // 4. Entity detection (m4a container)
    assert(
      "4. entities section present (m4a input)",
      textOf(entities.final).includes("--- entities ---") &&
        Array.isArray(entities.final.structuredContent?.entities)
    );

    // 5. PII redaction (default policies include person_name)
    assert(
      "5. PII redaction replaces person names",
      textOf(pii.final).includes("[PERSON_NAME]"),
      // Never print the transcript here: on failure it is exactly the text
      // whose PII redaction did NOT happen. Report a content-free diagnostic.
      `status=${pii.final.structuredContent?.status} PERSON_NAME markers: ${
        (textOf(pii.final).match(/\[PERSON_NAME\]/g) ?? []).length
      }, text length: ${textOf(pii.final).length}`
    );

    // 6. Summarize the plain transcript via LLM Gateway
    const summary = await callTool(client, "summarize_transcript", {
      transcript_id: plain.id,
      style: "bullets",
    });
    assert(
      "6. summarize_transcript returns a summary",
      summary.isError !== true && textOf(summary).trim().length > 0,
      textOf(summary).slice(0, 200)
    );

    // 7. Unreachable audio URL fails gracefully (either rejected at submit or
    // surfaces as status=error from polling — both are acceptable).
    try {
      const bad = await submitAndPoll(client, createdIds, { audio_url: BAD_URL });
      assert(
        "7. bad audio URL surfaces status=error",
        bad.final.structuredContent?.status === "error" &&
          textOf(bad.final).includes("status=error"),
        textOf(bad.final).slice(0, 200)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert("7. bad audio URL rejected with a clear error", msg.length > 0, msg);
    }

    // 8. Inline Speech Understanding: translation + chaptered summary
    const suText = textOf(understanding.final);
    assert(
      "8. inline SU renders translation:es section",
      suText.includes("--- translation:es ---"),
      suText.slice(0, 300)
    );
    assert("8. inline SU renders su_summary section", suText.includes("--- su_summary"), suText.slice(0, 300));

    // 9. Guardrails: content safety section (label presence depends on audio; the
    // structuredContent field must exist even when no labels fire)
    assert(
      "9. content_safety_labels in structuredContent",
      guardrails.final.structuredContent?.content_safety_labels !== undefined ||
        textOf(guardrails.final).includes("--- content_safety"),
      JSON.stringify(guardrails.final.structuredContent).slice(0, 300)
    );

    // 10. Post-hoc understanding on the plain transcript
    const understood = await callTool(client, "understand_transcript", {
      transcript_id: plain.id,
      speech_understanding: { request: { action_items: {} } },
    });
    assert(
      "10. understand_transcript returns action_items",
      understood.isError !== true && textOf(understood).includes("--- action_items ---"),
      textOf(understood).slice(0, 300)
    );
  } finally {
    // 11. Teardown: delete every transcript this run successfully created,
    // even if an assertion above threw mid-run. Each delete is isolated so
    // one failure doesn't skip cleanup of the rest.
    for (const id of createdIds) {
      try {
        const deleted = await callTool(client, "delete_transcript", { transcript_id: id });
        assert(
          `11. delete_transcript ${id}`,
          deleted.isError !== true && deleted.structuredContent?.deleted === true,
          textOf(deleted)
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        assert(`11. delete_transcript ${id}`, false, msg);
      }
    }
  }

  await client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("live-test crashed:", err);
  process.exit(1);
});
