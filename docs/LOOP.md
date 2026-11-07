# Loop

Search a public page, verify a claim against that page, and keep the receipt. The same call exists as a CLI, an SDK, a local MCP server, and a hosted API.

A credit moves only when a source loads. A timeout, a refused address, or an HTTP error returns the failed receipt and costs nothing.

## Install

```bash
npm install @talocode/loop
```

The command is `talocode-loop`.

## CLI

Local. No API key. No credit.

```bash
talocode-loop run \
  --query="Talocode official mint" \
  --url=https://talocode.site/llms.txt \
  --claim=6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory
```

A research brief fetches every source you name. `recommendation` is `do_not_ship` when any source fails, and `review` when every source responds. It does not decide to ship.

```bash
talocode-loop brief \
  --question="Is this source enough?" \
  --url=https://talocode.site/llms.txt
```

## SDK

```js
import { TalocodeLoop } from "@talocode/loop";

const local = new TalocodeLoop();
await local.run({
  query: "Talocode official mint",
  url: "https://talocode.site/llms.txt",
  claim: "6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory",
});
```

Set the base URL to use the hosted API. The key is the same key as the rest of Talocode Cloud.

```js
const hosted = new TalocodeLoop({
  baseUrl: "https://api.talocode.site",
  apiKey: process.env.TALOCODE_API_KEY,
});
```

`TALOCODE_LOOP_URL` and `TALOCODE_API_KEY` are the environment names.

## MCP

Local server:

```bash
talocode-loop mcp
```

Tools: `loop_run`, `loop_brief`.

Hosted tools on `https://api.talocode.site/mcp`, with the same API key:

| Tool | Credits |
|---|---|
| `loop_health` | free |
| `loop_pricing` | free |
| `loop_capabilities` | free |
| `loop_run` | 1 if the page loads |
| `loop_brief` | 1 per page that loads, maximum 5 |
| `loop_audit` | 1 if the page loads, up to 8 claims |

## Hosted API

Base URL: `https://api.talocode.site`

| Method | Path | Auth | Credits |
|---|---|---|---|
| GET | `/v1/loop/health` | no | 0 |
| GET | `/v1/loop/pricing` | no | 0 |
| GET | `/v1/loop/capabilities` | no | 0 |
| POST | `/v1/loop/run` | Bearer key | 1 if the page loads |
| POST | `/v1/loop/brief` | Bearer key | 1 per page that loads |
| POST | `/v1/loop/audit` | Bearer key | 1 if the page loads, up to 8 claims |

```bash
curl -s https://api.talocode.site/v1/loop/run \
  -H "authorization: Bearer $TALOCODE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"query":"Talocode official mint","url":"https://talocode.site/llms.txt","claim":"6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory"}'
```

The hosted route accepts public `https` URLs only. It refuses localhost, private addresses, and link-local addresses. Page text is not returned. A run receipt has the status, up to eight matching lines, whether the claim was present, and the line that contained it.

`/v1/loop/audit` loads the page once and checks every claim you send, up to 8. That is still one credit. A claim that is absent stays in the receipt with `found: false`. It does not get a second fetch.

```bash
curl -s https://api.talocode.site/v1/loop/audit \
  -H "authorization: Bearer $TALOCODE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"query":"Talocode token facts","url":"https://talocode.site/llms.txt","claims":["6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory","500,000 TCODE fixed","unlimited supply"]}'
```

`usage.credits` is `0` when nothing loaded. `usage.remaining` is the balance after a charge.

## What this does not do

It does not browse a logged-in site. It does not decide that a product should ship. `review` means every named source responded.
