# filingscope

American public life leaves a paper trail: insider trades filed with the SEC, members of Congress reporting stock purchases, lobbyists registering, drug approvals, bank call reports, Treasury auctions, disaster declarations. filingscope is a small local bridge to the hosted Keyvex MCP service, which gathers those published US public records into one queryable surface of 64 read tools.

Nothing is fetched or stored on your own machine by this package. It answers `tools/list` locally from the captured tool definitions and forwards every `tools/call` to the hosted service over a streamable-HTTP JSON-RPC session, returning whatever the service sends back unchanged.

## The tools

Every tool is a read over published records; none of them writes, buys, subscribes, checks out, or mints a key. Most take a ticker, a CIK, a name, or a date range, and most declare no required arguments — the two exceptions are the price tools at the end of the list.

- **SEC ownership and filings** — `get_insider_filings`, `get_insider_transactions` and `get_insider_holdings` cover Form 3/4/5 activity; `get_institutional_holdings`, `get_activist_stakes` and `get_planned_insider_sales` cover 13F-style positions and planned sales; `get_nport_filings`, `get_money_market_funds`, `get_fund_holdings`, `get_registration_statements`, `get_proxy_filings`, `get_delistings`, `get_tender_offers`, `get_private_placements`, `get_sec_comment_letters`, `get_sec_fails_to_deliver` and `get_material_events` cover the rest of the EDGAR beat.
- **Congress, campaigns and influence** — `get_congressional_trades`, `get_annual_financial_disclosures` and `get_member_profile` cover STOCK Act and disclosure filings; `get_fec_candidate_profile`, `get_fec_contributions`, `get_fec_disbursements` and `get_fec_independent_expenditures` cover campaign finance; `get_lobbying_filings`, `get_lobbyist_contributions` and `get_foreign_agents` cover influence filings.
- **Government money and oversight** — `get_federal_contracts`, `get_federal_grants`, `get_treasury_auctions`, `get_fema_disasters`, `get_federal_register_documents`, `get_government_publications`, `get_oig_exclusions` and `get_open_payments`.
- **Regulators and enforcement** — `get_fda_approvals`, `get_drug_adverse_events`, `get_product_recalls`, `get_bank_financials`, `get_enforcement_actions`, `get_epa_enforcement`, `get_osha_enforcement`, `get_nlrb_cases`, `get_ferc_filings`, `get_investment_advisers`, `get_ofac_sdn`, `get_screening_list` and `get_consumer_complaints`.
- **Company and market data** — `get_company_profile`, `get_fundamentals`, `get_corporate_patents`, `get_nonprofit_filings`, `get_h1b_filings`, `get_aircraft_registry`, `get_alerts`, `get_bills`, `get_roll_call_votes`, `get_crowdfunding_offerings`, `get_reg_a_offerings`, `get_economic_indicators` and `get_cftc_cot_reports`.
- **Prices** — `get_daily_prices` and `get_intraday_quote`, the only two tools that require an argument: `ticker`.
- **Cross-collection search** — `unified_search` fans one identifier (a ticker, a CIK, a bioguide id, a UEI, a company name or a CUSIP) out across every collection that indexes it and returns the results grouped by source.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/filingscope mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "filingscope": {
      "command": "npx",
      "args": ["-y", "@reneturcios/filingscope", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/filingscope
docker run --rm ghcr.io/cloudcorprecords/filingscope get_daily_prices '{"ticker":"AAPL"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
filingscope get_insider_filings '{"ticker":"AAPL","document_type":"4"}'
filingscope get_congressional_trades '{"ticker":"NVDA"}'
filingscope get_company_profile '{"ticker":"TSLA"}'
filingscope unified_search '{"company_cik":"0000320193"}'
filingscope --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `KEYVEX_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://mcp.keyvex.com`. (The override variable is a reconstruction added by this rebuild.)
- `KEYVEX_API_KEY` — When set, its value is sent to the upstream on every request as an `Authorization: Bearer <value>` header. When it is not set, no key header is sent at all, matching the keyless behaviour the tool surface was captured with. (The variable name and the Bearer form are reconstructions; the hosted service's registry record declares an `Authorization` header only on a separate pro remote and pins no package environment name.)

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `filingscope error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface tool by tool, exercises the session handshake and its reuse, covers both key-header branches, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
