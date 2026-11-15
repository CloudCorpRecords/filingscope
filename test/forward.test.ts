import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  FilingscopeClient,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Keyvex endpoint is never
 * contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/keyvex-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const FILINGS_TOOL = "get_insider_filings";
const PRICES_TOOL = "get_daily_prices";
const QUOTE_TOOL = "get_intraday_quote";
const PROFILE_TOOL = "get_company_profile";
const SEARCH_TOOL = "unified_search";

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"rows\":[],\"count\":0}" }],
  structuredContent: { rows: [], count: 0 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "keyvex", version: "0.102.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new FilingscopeClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function toolByName(name: string): ToolDef {
  const tool = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 64 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 64);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 64 tool names in fixture order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.deepEqual(
      TOOL_NAMES,
      fixture.tools.map((t) => t.name),
    );
    assert.equal(TOOL_NAMES.length, 64);
    assert.equal(TOOL_NAMES[0], "get_insider_filings");
    assert.equal(TOOL_NAMES[63], "unified_search");
  });

  it("carries exactly the fixture's keys on each tool, and no title anywhere", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
      assert.equal("title" in tool, false);
    }
  });

  it("carries no required key on 62 of the 64 tools", () => {
    const withRequired = TOOL_DEFS.filter(
      (tool) => "required" in schemaOf(tool),
    ).map((tool) => tool.name);
    assert.deepEqual(withRequired, [PRICES_TOOL, QUOTE_TOOL]);
    for (const tool of TOOL_DEFS) {
      if (tool.name !== PRICES_TOOL && tool.name !== QUOTE_TOOL) {
        assert.equal(schemaOf(tool).required, undefined);
      }
    }
  });

  it("requires exactly ticker on get_daily_prices and get_intraday_quote", () => {
    assert.deepEqual(schemaOf(toolByName(PRICES_TOOL)).required, ["ticker"]);
    assert.deepEqual(schemaOf(toolByName(QUOTE_TOOL)).required, ["ticker"]);
  });

  it("carries every fixture property, in order, for all 64 tools", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < 64; i += 1) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties ?? {});
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties ?? {});
      assert.deepEqual(served, expected, `property order for ${TOOL_NAMES[i]}`);
    }
  });

  it("carries the insider-filings filter shape verbatim", () => {
    const props = schemaOf(toolByName(FILINGS_TOOL)).properties;
    assert.deepEqual(Object.keys(props), [
      "accession_number",
      "ticker",
      "company_cik",
      "company_name",
      "document_type",
      "is_amendment",
      "reporting_owner_name",
      "since",
      "until",
      "sort_by",
      "sort_order",
      "limit",
    ]);
    assert.equal(props.ticker.type, "string");
    assert.equal(props.is_amendment.type, "boolean");
    assert.deepEqual(props.sort_order.enum, ["desc", "asc"]);
    assert.equal(props.limit.type, "integer");
    assert.equal(props.limit.maximum, 500);
    assert.equal(schemaOf(toolByName(FILINGS_TOOL)).additionalProperties, false);
  });

  it("carries the fixture's cross-reference wording in descriptions", () => {
    assert.match(
      toolByName(FILINGS_TOOL).description,
      /For the actual trades use get_insider_transactions/,
    );
    assert.match(toolByName(SEARCH_TOOL).description, /cross-collection fan-out/);
  });

  it("isKnownTool recognises all 64 built tools and rejects others", () => {
    for (const name of TOOL_NAMES) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("get-insider-filings"), false);
    assert.equal(isKnownTool("search"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://mcp.keyvex.com");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name filingscope and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRICES_TOOL, { ticker: "AAPL" });
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "filingscope", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    await c.callTool(PRICES_TOOL, { ticker: "AAPL" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(PROFILE_TOOL, { ticker: "TSLA" });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the KEYVEX_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new FilingscopeClient({
      fetchFn: upstream.fetchFn,
      env: { KEYVEX_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(SEARCH_TOOL, { ticker: "NVDA" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(PRICES_TOOL, { ticker: "MSFT" });
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { KEYVEX_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new FilingscopeClient({
      fetchFn: upstream.fetchFn,
      env: { KEYVEX_MCP_URL: "   " },
    });
    await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends Authorization: Bearer on every request when KEYVEX_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new FilingscopeClient({
      fetchFn: upstream.fetchFn,
      env: { KEYVEX_API_KEY: "kv-key-42" },
    });
    await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer kv-key-42",
      ),
    );
  });

  it("sends no Authorization header when KEYVEX_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header when KEYVEX_API_KEY is blank", async () => {
    const upstream = makeUpstream();
    const c = new FilingscopeClient({
      fetchFn: upstream.fetchFn,
      env: { KEYVEX_API_KEY: "   " },
    });
    await c.callTool(PRICES_TOOL, { ticker: "AAPL" });
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new FilingscopeClient({
      fetchFn: withKey.fetchFn,
      env: { KEYVEX_API_KEY: "kv-key-42" },
    });
    await c1.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.ok(withKey.calls.every((call) => call.headers["X-API-Key"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.ok(calls.every((call) => call.headers["X-API-Key"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a get_insider_filings call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { ticker: "AAPL", document_type: "4", since: "2025-01-01" };
    await c.callTool(FILINGS_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, FILINGS_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_daily_prices call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { ticker: "NVDA" };
    await c.callTool(PRICES_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRICES_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_intraday_quote call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { ticker: "TSLA" };
    await c.callTool(QUOTE_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, QUOTE_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a unified_search call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { company_cik: "0000320193" };
    await c.callTool(SEARCH_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "unknown ticker" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(PRICES_TOOL, { ticker: "ZZZZ" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(PROFILE_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      SEARCH_TOOL,
      { ticker: "AAPL" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_TOOL);
    assert.deepEqual(params.arguments, { ticker: "AAPL" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as filingscope error text", () => {
  it("maps a JSON-RPC error to `filingscope error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "query failed upstream" },
    });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "filingscope error: query failed upstream");
  });

  it("maps an initialize JSON-RPC error to filingscope error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "filingscope error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "filingscope error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "filingscope error: malformed response");
  });

  it("maps a non-2xx upstream status to filingscope error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "filingscope error: HTTP 500");
  });

  it("maps a throwing fetch to filingscope error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^filingscope error: /);
  });

  it("maps a throwing initialize fetch to filingscope error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "filingscope error: socket hang up");
  });

  it("maps a timed-out call to filingscope error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(FILINGS_TOOL, { ticker: "AAPL" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^filingscope error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, FILINGS_TOOL, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRICES_TOOL, "ticker=AAPL"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid get_insider_filings call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, FILINGS_TOOL, { ticker: "AAPL" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { ticker: "AAPL" });
  });

  it("forwards a valid unified_search call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH_TOOL, { ticker: "AAPL" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_TOOL);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH_TOOL, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PRICES_TOOL, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([PRICES_TOOL, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
