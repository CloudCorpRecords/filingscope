# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Keyvex MCP server. The 64 captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: 63 `get_*` reads over published US public records — SEC insider, institutional and fund filings, congressional trades and financial disclosures, FEC campaign finance, lobbying, FDA approvals and adverse events, EPA/OSHA/NLRB/FERC enforcement, federal contracts and grants, Treasury auctions, FEMA disasters and the Federal Register — plus `unified_search`, a cross-collection fan-out by identifier. Only `get_daily_prices` and `get_intraday_quote` declare a required argument (`ticker`). No tool in this surface writes, buys, subscribes, checks out or mints a key.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `filingscope error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `KEYVEX_MCP_URL`; when `KEYVEX_API_KEY` is set it is sent as an `Authorization: Bearer` header on every upstream request.
