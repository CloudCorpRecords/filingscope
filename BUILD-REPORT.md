# BUILD REPORT — filingscope

Clean-room rebuild of `com.keyvex/keyvex` v0.102.0 (remote-only MCP
server at `https://mcp.keyvex.com`), built 2026-10-28 as a forwarding
client. Package: `@reneturcios/filingscope` 0.1.0, registry name
`io.github.CloudCorpRecords/filingscope`.

## Surface built

Full surface built: **64/64 tools**, no omissions, in captured order —
63 `get_*` reads over published US public records (SEC insider,
institutional and fund filings; congressional trades and financial
disclosures; FEC campaign finance; lobbying and foreign-agent filings;
FDA approvals and adverse events; EPA/OSHA/NLRB/FERC enforcement;
federal contracts and grants; Treasury auctions; FEMA disasters; the
Federal Register; OFAC SDN and screening lists as published datasets)
plus `unified_search`, a cross-collection fan-out by identifier.

Required fields as served: 62 of the 64 tools carry **no** `required`
key in their inputSchema. The two exceptions, exactly as captured:

| Tool | Required fields as served |
|------|---------------------------|
| `get_daily_prices` | `ticker` |
| `get_intraday_quote` | `ticker` |

No tool carries a `title` key (none was captured; none was invented),
and no schema carries a schema-level `title` either. Tool literals were
generated programmatically from
`harness/fixtures/keyvex-tools-original.json` by the script at
`/tmp/b40-filingscope-gen.py` (parse + re-serialise into a template,
placeholder substitution into `src/forward.ts`) — never retyped — and
the registration-integrity test confirms the served literals deep-equal
the fixture's 64 tool objects in order. Tools are registered via the
MCP SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod, per the task
instruction overriding TEMPLATE.md §2 item 12.

## Fixture conflicts

**None.** The spec and the fixture agree on tool names, order, the two
`ticker`-required exceptions, the absence of `title` keys, and
descriptions.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://mcp.keyvex.com`.
- Env override `KEYVEX_MCP_URL` — labelled reconstruction.
- Env name `KEYVEX_API_KEY` — labelled reconstruction (the pinned
  remote declares no auth header; the `Authorization` header name is
  declared only on the registry record's sibling `/pro` remote, and
  the capture was keyless). When set, `Authorization: Bearer <value>`
  is sent on every upstream request; when unset, no key header is
  sent. Both branches are tested.
- Error rendering `filingscope error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the upstream —
  no live network calls in tests.

## Deviations

- **Parity command path form.** The task's parity command used the
  rebuild spec `stdio:node ~/workspace/mcp-rebuild-100/builds/filingscope/dist/cli.js mcp`.
  Run literally, the harness (which splits the command with `shlex` and
  launches it via `subprocess.Popen` with no shell) does not expand
  `~`, so node resolved the path relative to the working directory and
  the run reported UNREACHABLE. The parity run recorded below used the
  identical command with the `~` replaced by the absolute home path
  (`/home/hatch/workspace/...`); nothing else differed, and the
  resulting `parity-out/` is from that passing run.
- No other deviations.

## Lockfile

- Route: **Route 3** — generated clean from birth in the build dir
  with no `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/filingscope`.
- Package entries: **128**.
- sha256: `f816f05ded3ae358e82df7a1f116184712b869bb5e5c25f841acbb3095e12ac1`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "US public disclosures in one API: SEC filings,
  Congress trades, FEC, lobbying, FDA and more." — **92 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/filingscope:0.1.0`) carries **no**
  `version` field. Dockerfile (node:20-alpine, both stages) carries
  the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/filingscope"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/filingscope`
  and its smoke test asserts the server name `filingscope`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`; unknown subcommand → Usage
   on stderr listing all 64 tools, exit 2.
4. `npm test` → **54 tests, 54 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 64
   tools in order, plus the no-`title` and `required`-key shape of the
   surface, session handling/reuse, env override, key-header
   present/absent/blank branches, verbatim argument forwarding and
   result pass-through including upstream isError, SSE parsing, error
   rendering, MCP-layer validation, and CLI behaviour).
5. Parity: `python3 harness/parity.py --original
   harness/fixtures/keyvex-tools-original.json --rebuild
   "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/filingscope/dist/cli.js mcp"
   --out builds/filingscope/parity-out` → **verdict PASS, parity
   100.0** (64/64 identical, 0 missing, 0 extra, no schema diffs).
   Output in `parity-out/`. (See Deviations for the path-form note.)
