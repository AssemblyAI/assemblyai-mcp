# AssemblyAI

![AssemblyAI](./assets/logo.png)

Transcribe audio and video and turn completed transcripts into useful results in Claude. This plugin bundles an AssemblyAI workflow skill with the hosted AssemblyAI MCP connector. It supports speaker labels, summaries, translation, action items, PII redaction, transcript retrieval, and explicitly requested deletion through the tools available on the connected server.

## Connect

Add the plugin and complete the AssemblyAI OAuth sign-in when Claude prompts you. An AssemblyAI account with sufficient API credit is required. Usage is billed through AssemblyAI according to your account and enabled features. Do not paste passwords, OAuth tokens, or API keys into chat.

The MCP endpoint is `https://mcp.assemblyai.com/mcp`, the same endpoint used by the AssemblyAI connector already listed in the Claude directory. This bundle does not configure new OAuth scopes or change the server's authentication settings.

## Try it

- “Transcribe https://assembly.ai/wildfires.mp3 with speaker labels.”
- “Summarize that completed transcript and extract action items.”
- “Translate the transcript to Spanish.”
- “Create a new transcription with the PII redaction policies I specify.”
- “Delete transcript <transcript_id>.” Deletion is permanent.

Transcription runs asynchronously. The skill teaches Claude to submit once, keep the transcript ID, and retrieve the result until processing completes. Local file uploads depend on the Claude app's tools, file access, network permissions, and the server's current upload limits. If uploading is unavailable, provide an accessible direct audio/video URL.

## Data handling

When you invoke a tool, Claude sends the required media URL, transcript ID, requested processing options, and any analysis instructions to the hosted AssemblyAI MCP server. For local-file workflows, the requested audio/video is uploaded through the server's supported upload flow. The server forwards requests to the AssemblyAI API using the connected account. Transcripts and requested analysis results are returned to Claude.

The plugin files are instructions and connector configuration; they do not run a local server, hook, or background process. AssemblyAI API transcript retention and deletion are governed by your account and AssemblyAI's policies. The `delete_transcript` tool deletes the specified API transcript; it does not delete the original media hosted elsewhere. Use sample data when testing and only submit media you are authorized to process.

## Links

- [Documentation](https://www.assemblyai.com/docs/mcp-server)
- [Support](https://support.assemblyai.com)
- [Privacy policy](https://www.assemblyai.com/legal/privacy-policy)
- [Terms of service](https://www.assemblyai.com/legal/terms-of-service)
- [Security](https://www.assemblyai.com/security)

## Version 1.0.0

Initial Claude plugin bundle: the existing hosted MCP connector, a transcription and transcript-understanding workflow skill, and the approved square AssemblyAI logo.

## License

MIT. See [LICENSE](./LICENSE).
