import { api } from "./api";
import { handleMcp } from "./mcp";
import { isMcpPath } from "./paths";
import type { AppEnv } from "./types";

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isMcpPath(url.pathname)) {
      return handleMcp(request, env, ctx);
    }
    return api.fetch(request, env, ctx);
  },
};
