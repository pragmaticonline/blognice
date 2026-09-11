type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const SERVER_INFO = { name: "blognice", version: "1.0.0" };
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Accept, Accept-Language",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "86400",
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function getApiBase(c: any): string {
  try {
    const u = new URL(c.req.url);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return `${u.protocol}//${u.host}`;
  } catch {}
  const root = (c.env?.ROOT_DOMAIN as string) || "blognice.com";
  return `https://www.${root}`;
}

async function proxyToBlognice(c: any, apiKey: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const base = getApiBase(c);
  const url = `${base}/api/v1${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  let fetchBody: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }
  const tryInternal = async (): Promise<Response | null> => {
    const app = (globalThis as any).__BLOGNICE_APP ?? (globalThis as any).blogniceApp;
    if (app?.fetch) {
      const req = new Request(url, { method, headers, body: fetchBody });
      try {
        return await app.fetch(req, c.env, c.executionCtx ?? { waitUntil() {}, passThroughOnException() {} });
      } catch { return null; }
    }
    try {
      const mod: any = await import("./index.ts");
      const innerApp = mod?.blogniceApp;
      if (innerApp?.fetch) {
        const req = new Request(url, { method, headers, body: fetchBody });
        return await innerApp.fetch(req, c.env, c.executionCtx ?? { waitUntil() {}, passThroughOnException() {} });
      }
    } catch {}
    return null;
  };
  const internalRes = await tryInternal();
  if (internalRes) {
    const text = await internalRes.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: internalRes.ok, status: internalRes.status, json, text };
  }
  const res = await fetch(url, { method, headers, body: fetchBody });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

function toolText(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

export const BLOGNICE_MCP_TOOLS: McpTool[] = [
  {
    name: "blognice_get_me",
    description: "List your Blognice account and blogs. Returns public_id for each blog (use as blogId in other tools). Requires paid plan API key from https://www.blognice.com/admin/api-key.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string", description: "Blognice API key (Bearer token) from /admin/api-key. Optional when connected via OAuth — otherwise required." } }, required: [], additionalProperties: false },
  },
  {
    name: "blognice_create_blog",
    description: "Create a new Blognice blog. One account owns up to 5 blogs (1 on free). slug 3-40 a-z0-9-.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, slug: { type: "string", description: "Desired slug e.g. myblog (3-40, a-z0-9-)" }, title: { type: "string" }, description: { type: "string" } }, required: [], additionalProperties: true },
  },
  {
    name: "blognice_get_blog",
    description: "Get blog settings including navigation_links, header_link_url, accent_color, custom_domain, role.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string", description: "Opaque public_id from blognice_get_me" } }, required: [ "blogId"] },
  },
  {
    name: "blognice_update_blog",
    description: "Update blog settings (PATCH). Supports title, description, footer_name, accent_color (#rrggbb), topics, social_links, navigation_links [{label, href, order}], header_link_url (/ or https://), browser_push_enabled.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, footer_name: { type: "string" }, accent_color: { type: "string" }, topics: { type: "array", items: { type: "string" } }, social_links: { type: "object" }, navigation_links: { type: "array" }, header_link_url: { type: "string" }, browser_push_enabled: { type: "boolean" } }, required: [ "blogId"], additionalProperties: true },
  },
  {
    name: "blognice_list_posts",
    description: "List posts for a blog (published and drafts if owner).",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" } }, required: [ "blogId"] },
  },
  {
    name: "blognice_create_post",
    description: "Create a post. Required: title, body_md (markdown). Optional: slug, published (bool, default true), tags (string[]), author_name, featured_image_key, meta_description, show_in_lists.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, title: { type: "string" }, body_md: { type: "string", description: "Markdown body" }, slug: { type: "string" }, published: { type: "boolean" }, tags: { type: "array", items: { type: "string" } }, author_name: { type: "string" }, featured_image_key: { type: "string" }, meta_description: { type: "string" } }, required: [ "blogId", "title", "body_md"] },
  },
  {
    name: "blognice_get_post",
    description: "Get a single post by numeric id.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, postId: { type: "integer" } }, required: [ "blogId", "postId"] },
  },
  {
    name: "blognice_update_post",
    description: "Patch a post (title, body_md, slug, published, tags, author_name, featured_image_key, meta_description).",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, postId: { type: "integer" }, title: { type: "string" }, body_md: { type: "string" }, slug: { type: "string" }, published: { type: "boolean" }, tags: { type: "array", items: { type: "string" } }, author_name: { type: "string" }, featured_image_key: { type: "string" }, meta_description: { type: "string" } }, required: [ "blogId", "postId"] },
  },
  {
    name: "blognice_delete_post",
    description: "Delete a post by id.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, postId: { type: "integer" } }, required: [ "blogId", "postId"] },
  },
  {
    name: "blognice_list_pages",
    description: "List pages for a blog.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" } }, required: [ "blogId"] },
  },
  {
    name: "blognice_create_page",
    description: "Create a page. Required title. Optional body_md, slug, published, show_in_navigation, navigation_label, navigation_order, meta_description.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, title: { type: "string" }, body_md: { type: "string" }, slug: { type: "string" }, published: { type: "boolean" }, show_in_navigation: { type: "boolean" }, navigation_label: { type: "string" }, navigation_order: { type: "integer" }, meta_description: { type: "string" } }, required: [ "blogId", "title"] },
  },
  {
    name: "blognice_get_page",
    description: "Get a single page by id.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, pageId: { type: "integer" } }, required: [ "blogId", "pageId"] },
  },
  {
    name: "blognice_update_page",
    description: "Patch a page.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, pageId: { type: "integer" }, title: { type: "string" }, body_md: { type: "string" }, slug: { type: "string" }, published: { type: "boolean" }, show_in_navigation: { type: "boolean" }, navigation_label: { type: "string" }, navigation_order: { type: "integer" }, meta_description: { type: "string" } }, required: [ "blogId", "pageId"] },
  },
  {
    name: "blognice_delete_page",
    description: "Delete a page.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, pageId: { type: "integer" } }, required: [ "blogId", "pageId"] },
  },
  {
    name: "blognice_list_media",
    description: "List R2 media library keys for a blog.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" } }, required: [ "blogId"] },
  },
  {
    name: "blognice_get_metrics",
    description: "Get pageview metrics for a blog (requires owner).",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" } }, required: [ "blogId"] },
  },
  {
    name: "blognice_get_tags",
    description: "List tags used in a blog.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" } }, required: [ "blogId"] },
  },
  {
    name: "blognice_generate_image",
    description: "Generate an editorial image via Workers AI (credit-gated, paid plan). Provide prompt+style or post_id. Styles: editorial-photo, editorial-illustration, cinematic, child-crayon, arcade-action, risograph, paper-collage, watercolor, minimal, auto.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, prompt: { type: "string" }, style: { type: "string" }, post_id: { type: "integer" } }, required: [ "blogId"] },
  },
  {
    name: "blognice_get_image_status",
    description: "Poll image generation job status.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, jobId: { type: "string" } }, required: [ "blogId", "jobId"] },
  },
  {
    name: "blognice_generate_audio",
    description: "Generate TTS narration for a post (paid, credit-gated).",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, postId: { type: "integer" } }, required: [ "blogId", "postId"] },
  },
  {
    name: "blognice_get_audio_status",
    description: "Poll audio generation job status.",
    inputSchema: { type: "object", properties: { apiKey: { type: "string" }, blogId: { type: "string" }, jobId: { type: "string" } }, required: [ "blogId", "jobId"] },
  },
];

async function dispatchTool(c: any, name: string, args: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  let apiKey = String(args?.apiKey || "").trim();
  if (!apiKey) {
    const hdr = (c.req?.header?.("authorization") || c.req?.headers?.get?.("authorization") || "") as string;
    const m = String(hdr).match(/^Bearer\s+(.+)$/i);
    if (m) apiKey = m[1].trim();
  }
  if (!apiKey) {
    return { content: [{ type: "text", text: "Missing apiKey. Generate one at https://www.blognice.com/admin/api-key (paid plan required) or connect via OAuth at https://www.blognice.com/oauth/authorize. Pass it as \"apiKey\" in every tool call when not using OAuth. Example: {\"apiKey\":\"YOUR_KEY\", \"title\":\"Hello\"}" }], isError: true };
  }
  const blogId = args?.blogId ? String(args.blogId) : "";
  const postId = args?.postId ?? args?.id ?? args?.pageId;
  try {
    switch (name) {
      case "blognice_get_me": {
        const r = await proxyToBlognice(c, apiKey, "GET", "/me");
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_create_blog": {
        const body: any = {};
        if (args.slug) body.slug = String(args.slug);
        if (args.title) body.title = String(args.title);
        if (args.description) body.description = String(args.description);
        if (args.accent_color) body.accent_color = String(args.accent_color);
        const r = await proxyToBlognice(c, apiKey, "POST", "/blogs", body);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_get_blog": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_update_blog": {
        const patch: any = {};
        for (const k of ["title", "description", "footer_name", "accent_color", "topics", "social_links", "navigation_links", "header_link_url", "browser_push_enabled", "slug"]) if (k in args) patch[k] = (args as any)[k];
        const r = await proxyToBlognice(c, apiKey, "PATCH", `/blogs/${encodeURIComponent(blogId)}`, patch);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_list_posts": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/posts`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_create_post": {
        const body: any = { title: String(args.title), body_md: String(args.body_md) };
        if ("slug" in args && args.slug) body.slug = String(args.slug);
        if ("published" in args) body.published = Boolean(args.published);
        if ("tags" in args && args.tags) body.tags = args.tags;
        if ("author_name" in args) body.author_name = String(args.author_name);
        if ("featured_image_key" in args) body.featured_image_key = String(args.featured_image_key);
        if ("meta_description" in args) body.meta_description = String(args.meta_description);
        const r = await proxyToBlognice(c, apiKey, "POST", `/blogs/${encodeURIComponent(blogId)}/posts`, body);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_get_post": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(String(postId))}`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_update_post": {
        const patch: any = {};
        for (const k of ["title", "body_md", "slug", "published", "tags", "author_name", "featured_image_key", "meta_description"]) if (k in args) patch[k] = (args as any)[k];
        const r = await proxyToBlognice(c, apiKey, "PATCH", `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(String(postId))}`, patch);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_delete_post": {
        const r = await proxyToBlognice(c, apiKey, "DELETE", `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(String(postId))}`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_list_pages": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/pages`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_create_page": {
        const body: any = { title: String(args.title) };
        for (const k of ["body_md", "slug", "published", "show_in_navigation", "navigation_label", "navigation_order", "meta_description"]) if (k in args) body[k] = (args as any)[k];
        const r = await proxyToBlognice(c, apiKey, "POST", `/blogs/${encodeURIComponent(blogId)}/pages`, body);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_get_page": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/pages/${encodeURIComponent(String(postId))}`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_update_page": {
        const patch: any = {};
        for (const k of ["title", "body_md", "slug", "published", "show_in_navigation", "navigation_label", "navigation_order", "meta_description"]) if (k in args) patch[k] = (args as any)[k];
        const r = await proxyToBlognice(c, apiKey, "PATCH", `/blogs/${encodeURIComponent(blogId)}/pages/${encodeURIComponent(String(postId))}`, patch);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_delete_page": {
        const r = await proxyToBlognice(c, apiKey, "DELETE", `/blogs/${encodeURIComponent(blogId)}/pages/${encodeURIComponent(String(postId))}`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_list_media": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/media`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_get_metrics": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/metrics`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_get_tags": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/tags`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_generate_image": {
        const body: any = {};
        if (args.prompt) body.prompt = String(args.prompt);
        if (args.style) body.style = String(args.style);
        if (args.post_id) body.post_id = Number(args.post_id);
        const r = await proxyToBlognice(c, apiKey, "POST", `/blogs/${encodeURIComponent(blogId)}/images/generations`, body);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_get_image_status": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/images/generations/${encodeURIComponent(String(args.jobId))}`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_generate_audio": {
        const r = await proxyToBlognice(c, apiKey, "POST", `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(String(postId))}/audio/generations`, {});
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      case "blognice_get_audio_status": {
        const r = await proxyToBlognice(c, apiKey, "GET", `/blogs/${encodeURIComponent(blogId)}/audio/generations/${encodeURIComponent(String(args.jobId))}`);
        return { content: [{ type: "text", text: toolText(r.json ?? r.text) }], isError: !r.ok };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e: any) {
    return { content: [{ type: "text", text: `Tool ${name} failed: ${e?.message || String(e)}` }], isError: true };
  }
}

function handleInitialize(id: any, params: any): any {
  const requested = String(params?.protocolVersion || "");
  const version = PROTOCOL_VERSIONS.has(requested) ? requested : "2024-11-05";
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    },
  };
}

export async function handleMcpRequest(c: any): Promise<Response> {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders() } as any });
  }
  if (c.req.method === "GET") {
    return jsonResponse({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      description: "Blognice MCP server — manage blogs, posts, pages, media via ChatGPT. POST JSON-RPC to this URL.",
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      endpoints: { mcp: "/mcp", openapi: "/openapi.yaml", plugin: "/.well-known/ai-plugin.json" },
      tools: BLOGNICE_MCP_TOOLS.map((t) => t.name),
    });
  }
  if (c.req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, { status: 405 });
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } }, { status: 400 });
  }

  const messages: any[] = Array.isArray(body) ? body : [body];
  const responses: any[] = [];

  for (const msg of messages) {
    const id = msg?.id ?? null;
    const method = String(msg?.method || "");
    const params = msg?.params || {};

    if (!method) {
      responses.push({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing method" } });
      continue;
    }

    const isNotification = msg.id === undefined;

    if (method === "initialize") {
      responses.push(handleInitialize(id, params));
      continue;
    }
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      // No response for notifications per JSON-RPC
      continue;
    }
    if (method === "ping") {
      if (isNotification) continue;
      responses.push({ jsonrpc: "2.0", id, result: {} });
      continue;
    }
    if (method === "tools/list") {
      responses.push({ jsonrpc: "2.0", id, result: { tools: BLOGNICE_MCP_TOOLS } });
      continue;
    }
    if (method === "tools/call") {
      const toolName = String(params?.name || "");
      const toolArgs = params?.arguments || {};
      const result = await dispatchTool(c, toolName, toolArgs);
      responses.push({ jsonrpc: "2.0", id, result: { content: result.content, isError: result.isError || false } });
      continue;
    }
    if (method === "resources/list" || method === "prompts/list" || method === "prompts/get" || method === "resources/templates/list") {
      const emptyKey = method === "prompts/list" ? "prompts" : method === "prompts/get" ? "prompt" : "resources";
      // Return empty list for unsupported capabilities
      if (method === "prompts/get") responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: "Prompt not found" } });
      else responses.push({ jsonrpc: "2.0", id, result: { [emptyKey]: [] } });
      continue;
    }

    responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  // If all messages were notifications, respond 202 with empty body per spec
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: corsHeaders() as any });
  }

  const single = !Array.isArray(body);
  const payload = single ? responses[0] : responses;
  return jsonResponse(payload);
}

export function aiPluginManifest(c: any): Record<string, unknown> {
  const origin = (() => {
    try { const u = new URL(c.req.url); return `${u.protocol}//${u.host}`; } catch { return `https://www.${(c.env?.ROOT_DOMAIN as string) || "blognice.com"}`; }
  })();
  // Always advertise www as canonical for ChatGPT, but respect current origin for dev
  const canonical = origin.includes("localhost") ? origin : "https://www.blognice.com";
  return {
    schema_version: "v1",
    name_for_human: "Blognice",
    name_for_model: "blognice",
    description_for_human: "Create and manage blogs, posts, pages, and media on Blognice — privacy-first blogging.",
    description_for_model: "Token-protected Blognice API for managing up to 5 blogs per account. Requires per-tool apiKey from https://www.blognice.com/admin/api-key. Use blognice_get_me to discover blog public_id, then posts/pages/media tools. Base https://www.blognice.com — see https://www.blognice.com/openapi.yaml.",
    auth: { type: "none" },
    api: { type: "openapi", url: `${canonical}/openapi.yaml` },
    logo_url: `${canonical}/favicon.svg`,
    contact_email: "press@blognice.com",
    legal_info_url: `${canonical}/terms`,
  };
}
