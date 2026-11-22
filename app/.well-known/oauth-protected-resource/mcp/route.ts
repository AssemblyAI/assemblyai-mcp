// RFC 9728 section 3: the metadata of the resource https://<host>/mcp is at
// /.well-known/oauth-protected-resource/mcp (the well-known segment goes between
// the host and the path). Same document as the root URL.
export { GET } from "../route";
