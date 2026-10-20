import { headers } from "next/headers";

// A short page for people who open the server's address in a browser. AI apps
// never see it: they talk to /mcp. Keep the tool list in sync with src/server.ts.
const TOOLS = [
  { name: "submit_transcript", what: "Start transcribing a public audio or video URL" },
  { name: "get_transcript", what: "Get status and results: text, speakers, timestamps" },
  { name: "summarize_transcript", what: "Summarize a completed transcript" },
  { name: "understand_transcript", what: "Translate, find action items, identify speakers" },
  { name: "delete_transcript", what: "Permanently delete a transcript" },
];

const css = `
  :root { --bg:#f6f7fb; --fg:#16192b; --muted:#5b6078; --card:#fff; --line:#d9dcea; --accent:#2f5bea; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1120; --fg:#eceefa; --muted:#a3a8c3; --card:#181b2e; --line:#2d3150; --accent:#7f9dff; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 56px 20px 64px; display: grid; gap: 28px; }
  h1 { font-size: 2rem; line-height: 1.15; margin: 0 0 8px; }
  h2 { font-size: 1.05rem; margin: 0 0 10px; }
  p { margin: 0; color: var(--muted); }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin: 0; padding: 14px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; color: var(--fg); }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  li { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: 12px; padding: 10px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  li code { color: var(--accent); }
  li span { color: var(--muted); }
  a { color: var(--accent); }
  @media (max-width: 560px) { li { grid-template-columns: minmax(0, 1fr); gap: 2px; } }
`;

export default async function Home() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "mcp.assemblyai.com";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const endpoint = `${proto}://${host}/mcp`;

  return (
    <main>
      <style>{css}</style>
      <section>
        <h1>AssemblyAI MCP Server</h1>
        <p>
          Lets AI apps such as Claude, Cursor and other MCP clients transcribe and analyze audio with AssemblyAI. This
          address is for apps, not browsers: connect to the endpoint below with your AssemblyAI API key.
        </p>
      </section>

      <section>
        <h2>Endpoint</h2>
        <pre>{endpoint}</pre>
      </section>

      <section>
        <h2>Connect from Claude Code</h2>
        <pre>{`claude mcp add --transport http assemblyai ${endpoint} \\
  --header "Authorization: Bearer $ASSEMBLYAI_API_KEY"`}</pre>
      </section>

      <section>
        <h2>Tools</h2>
        <ul>
          {TOOLS.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              <span>{t.what}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <p>
          Get an API key in the <a href="https://www.assemblyai.com/dashboard">AssemblyAI dashboard</a>. Docs:{" "}
          <a href="https://www.assemblyai.com/docs">assemblyai.com/docs</a>. Source:{" "}
          <a href="https://github.com/AssemblyAI/assemblyai-mcp">github.com/AssemblyAI/assemblyai-mcp</a>.
        </p>
      </section>
    </main>
  );
}
