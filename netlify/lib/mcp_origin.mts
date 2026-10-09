/** Candidate for the MCP route ONLY, not all OAuth endpoints.
 * Missing Origin is a valid server-to-server case, but an explicitly untrusted
 * Origin must not be accepted merely because the bearer token is valid.
 * Add an origin only after observing and validating the actual client identity.
 */
export function mcpOriginAllowed(origin: string | null, allowed: ReadonlySet<string>): boolean {
  if (origin === null) return true;
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.origin !== origin || !allowed.has(origin)) return false;
    return true;
  } catch { return false; }
}
export const EXPECTED_MCP_ORIGINS = new Set([
  'https://jev-decision-fabric.example',
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
// Integration candidate in app.mts, before handling /mcp:
// if (path === '/mcp' && !mcpOriginAllowed(req.headers.get('origin'), EXPECTED_MCP_ORIGINS))
//   throw new Fault('MCP_ORIGIN_NOT_ALLOWED', 403);
// Keep /oauth/session's same-origin check, consent CSRF/session binding,
// the code+PKCE and client checks, and all token issuer/audience/scope checks.
