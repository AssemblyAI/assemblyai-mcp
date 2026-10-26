import type { ReactNode } from "react";

export const metadata = {
  title: "AssemblyAI MCP Server",
  description: "Remote MCP server for the AssemblyAI API: transcription, Speech Understanding and Guardrails.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
