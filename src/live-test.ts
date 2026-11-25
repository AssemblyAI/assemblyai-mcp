import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001/mcp";
const API_KEY = process.env.ASSEMBLYAI_API_KEY;

const SHORT_CLIP = "https://assembly.ai/sports_injuries.mp3";
const INTERVIEW_CLIP = "https://assembly.ai/wildfires.mp3";
const M4A_CLIP = "https://assembly.ai/new-approved-medication";
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

  const tools = await client.listTools();
  const optional = new Set(["create_upload_url", "create_speech"]);
  const names = tools.tools.map((t) => t.name).filter((n) => !optional.has(n)).sort();
  assert(
    "1. tools/list exposes the 5 transcript tools",
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

  const createdIds: string[] = [];

  try {
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

    assert("2. plain transcription completes", plain.final.structuredContent?.status === "completed");
    assert(
      "2. speech_model_used=assemblyai-stt-3-7 in structuredContent",
      plain.final.structuredContent?.speech_model_used === "assemblyai-stt-3-7",
      String(plain.final.structuredContent?.speech_model_used)
    );
    assert(
      "2. speech_model_used appears in text payload",
      textOf(plain.final).includes("speech_model_used=assemblyai-stt-3-7")
    );
    assert("2. text section present", textOf(plain.final).includes("--- text ---"));

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

    assert(
      "4. entities section present (m4a input)",
      textOf(entities.final).includes("--- entities ---") &&
        Array.isArray(entities.final.structuredContent?.entities)
    );

    assert(
      "5. PII redaction replaces person names",
      textOf(pii.final).includes("[PERSON_NAME]"),
      // Never print the transcript: on failure it holds the unredacted PII.
      `status=${pii.final.structuredContent?.status} PERSON_NAME markers: ${
        (textOf(pii.final).match(/\[PERSON_NAME\]/g) ?? []).length
      }, text length: ${textOf(pii.final).length}`
    );

    const summary = await callTool(client, "summarize_transcript", {
      transcript_id: plain.id,
      style: "bullets",
    });
    assert(
      "6. summarize_transcript returns a summary",
      summary.isError !== true && textOf(summary).trim().length > 0,
      textOf(summary).slice(0, 200)
    );

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

    const suText = textOf(understanding.final);
    assert(
      "8. inline SU renders translation:es section",
      suText.includes("--- translation:es ---"),
      suText.slice(0, 300)
    );
    assert("8. inline SU renders su_summary section", suText.includes("--- su_summary"), suText.slice(0, 300));

    assert(
      "9. content_safety_labels in structuredContent",
      guardrails.final.structuredContent?.content_safety_labels !== undefined ||
        textOf(guardrails.final).includes("--- content_safety"),
      JSON.stringify(guardrails.final.structuredContent).slice(0, 300)
    );

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
