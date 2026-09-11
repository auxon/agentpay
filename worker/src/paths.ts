/** agentpay is mounted on path routes — never take over entangleit.com itself. */
export const APP_PREFIX = "/agentpay";
export const API_PREFIX = "/api/agentpay";
export const MCP_PATH = `${API_PREFIX}/mcp`;
export const PUBLIC_SITE = "https://entangleit.com";

export function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PATH || pathname === `${MCP_PATH}/`;
}

/** Canonical site origin used in Checkout redirect URLs. */
export function siteOrigin(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname === "entangleit.com" || url.hostname === "www.entangleit.com") {
    return PUBLIC_SITE;
  }
  return url.origin;
}
