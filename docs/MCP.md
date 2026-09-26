# Talocode MCP endpoint

`POST https://api.talocode.site/mcp` speaks JSON-RPC 2.0 over streamable HTTP and exposes Talocode
Cloud capabilities as MCP tools. Auth is `Authorization: Bearer $TALOCODE_API_KEY`.

The `@talocode/mcp` npm package is a local stdio bridge for clients that cannot send custom HTTP
headers; it forwards `tools/list` and `tools/call` to this endpoint.

## Registry policy

`143` tools are defined. **Only tools whose route this deployment can actually serve are
advertised.** Advertising a tool that returns nothing is worse than not listing it: an agent that
tries it concludes the platform is broken.

| | Count |
|---|---|
| Defined | 143 |
| Advertised in `tools/list` | 64 |
| Hidden | 81 |

`GET /mcp` reports `tools`, `toolsDefined` and `toolsHidden` so the gap stays visible instead of
being quietly absorbed.

Hidden tools belong to products with no route in this deployment:

  - `/v1/codra/`
  - `/v1/crawlerlane/`
  - `/v1/forgecad/`
  - `/v1/opensourcelane/`
  - `/v1/replylane/`
  - `/v1/signallane/`
  - `/v1/tradia/`
  - `/v1/ugclane/`
  - `/v1/webdatalane/`

They stay defined in `mcp-tools.mjs` so they can be switched on by adding the route, without
touching the registry.

## Dispatch

A `tools/call` is proxied **in-process** to the HTTP route that implements the tool, reusing the
route layer's API-key auth and credit charging rather than duplicating either. `GET` tools map their
arguments to query parameters; `POST` tools map them to a JSON body.

Two tools are answered in-process rather than proxied, because no route exists for them:

- `cloud_credits_balance` - balance, lifetime credits and lifetime spend for the key's project
- `cloud_usage_recent` - recent metered usage events for the key

These close a real gap: an API key could spend credits but had no way to read its own balance or
usage, since those routes were session-only.

A previously hardcoded placeholder returned for every tool call
("Underlying product service wiring is being connected"). It is gone.

## Verification

- `tests/mcp.test.mjs` - 23 tests: registry invariants, list filtering, request building, dispatch
  success and failure paths, and the internal tools. Run `npm test`.
- Local smoke through the real handler, no database required: `GET /mcp` reports 64 advertised of
  143 defined; `tools/list` includes `calclane_evaluate`, `searchlane_health`, `cloud_pricing` and
  both internal tools, and excludes `tradia_agent_plan` and `forgecad_design_generate`; the nine
  auth-free product health/pricing routes all answer 200.

## After deploy

Availability is verified at family level. These 55 tools resolve through a family
handler whose specific action has not been exercised yet and should be smoke-tested once deployed:

  - `agent_browser_analyze` -> `/v1/agent-browser/analyze`
  - `agent_browser_check` -> `/v1/agent-browser/check`
  - `agent_browser_extract` -> `/v1/agent-browser/extract`
  - `agent_browser_screenshot` -> `/v1/agent-browser/screenshot`
  - `agent_browser_trace_report` -> `/v1/agent-browser/trace-report`
  - `calclane_capabilities` -> `/v1/calclane/capabilities`
  - `calclane_dispatch` -> `/v1/calclane/dispatch`
  - `calclane_evaluate` -> `/v1/calclane/evaluate`
  - `calclane_health` -> `/v1/calclane/health`
  - `calclane_pricing` -> `/v1/calclane/pricing`
  - `doculane_extract` -> `/v1/doculane/extract`
  - `geolane_audit` -> `/v1/geolane/audit`
  - `geolane_capabilities` -> `/v1/geolane/capabilities`
  - `geolane_citation_readiness` -> `/v1/geolane/citation-readiness`
  - `geolane_compare` -> `/v1/geolane/compare`
  - `geolane_crawlers` -> `/v1/geolane/crawlers`
  - `geolane_health` -> `/v1/geolane/health`
  - `geolane_llms_txt` -> `/v1/geolane/llms-txt`
  - `geolane_pricing` -> `/v1/geolane/pricing`
  - `invoicelane_capabilities` -> `/v1/invoicelane/capabilities`
  - `invoicelane_export_csv` -> `/v1/invoicelane/export/csv`
  - `invoicelane_extract` -> `/v1/invoicelane/extract`
  - `invoicelane_extract_invoice` -> `/v1/invoicelane/invoice/extract`
  - `invoicelane_extract_receipt` -> `/v1/invoicelane/receipt/extract`
  - `invoicelane_health` -> `/v1/invoicelane/health`
  - `invoicelane_pricing` -> `/v1/invoicelane/pricing`
  - `invoicelane_validate` -> `/v1/invoicelane/validate`
  - `reliabilitylane_antipatterns` -> `/v1/reliabilitylane/antipatterns`
  - `reliabilitylane_capabilities` -> `/v1/reliabilitylane/capabilities`
  - `reliabilitylane_checklists` -> `/v1/reliabilitylane/checklists`
  - `reliabilitylane_health` -> `/v1/reliabilitylane/health`
  - `reliabilitylane_incident` -> `/v1/reliabilitylane/incident`
  - `reliabilitylane_match` -> `/v1/reliabilitylane/match`
  - `reliabilitylane_patterns` -> `/v1/reliabilitylane/patterns`
  - `reliabilitylane_playbooks` -> `/v1/reliabilitylane/playbooks`
  - `reliabilitylane_pricing` -> `/v1/reliabilitylane/pricing`
  - `reliabilitylane_retries` -> `/v1/reliabilitylane/retries`
  - `reliabilitylane_retry_plan` -> `/v1/reliabilitylane/retry-plan`
  - `reliabilitylane_verify` -> `/v1/reliabilitylane/verify`
  - `searchlane_capabilities` -> `/v1/searchlane/capabilities`
  - `searchlane_health` -> `/v1/searchlane/health`
  - `searchlane_news` -> `/v1/searchlane/news`
  - `searchlane_pricing` -> `/v1/searchlane/pricing`
  - `searchlane_query` -> `/v1/searchlane/query`
  - `searchlane_research` -> `/v1/searchlane/research`
  - `skills_export_claude` -> `/v1/skills/export/claude`
  - `skills_export_cursor` -> `/v1/skills/export/cursor`
  - `skills_generate_docs` -> `/v1/skills/generate/docs`
  - `skills_generate_github_profile` -> `/v1/skills/generate/github-profile`
  - `skills_generate_github_repo` -> `/v1/skills/generate/github-repo`
  - `skills_generate_recording` -> `/v1/skills/generate/recording`
  - `skills_generate_text` -> `/v1/skills/generate/text`
  - `tera_coding_explain` -> `/v1/tera/coding/explain`
  - `tera_coding_review` -> `/v1/tera/coding/review`
  - `tera_writing_draft` -> `/v1/tera/writing/draft`
