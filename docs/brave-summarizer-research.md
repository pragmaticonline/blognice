# Brave Search API: summarizer + news sourcing research

Question: can the answers/summarizer flow return source-article URLs for a
news-sourcing feature, and which plan does it require?

Short answer: yes. The legacy Summarizer returns per-source references
(`context`) plus optional inline citations, but it requires the
**discontinued Pro AI plan** (existing subscribers only). New integrations
should use the **Answers plan** (cited answers) or the **Search plan**
(raw URLs via Web/News search + LLM Context). Details below.

> Sources: ONLY official Brave docs. `api.search.brave.com` bot-blocks
> non-browser fetches (HTTP 403), so claims from that host are verified via
> its indexed documentation snippets; `api-dashboard.search.brave.com` and
> `brave.com/search/api/` were fetched directly (HTTP 200).

## 1. Summarizer flow (legacy, still served)

Two steps. Auth for both is the `X-Subscription-Token` header.

Step 1 — Web search with summary key generation:

```bash
curl -s --compressed \
  "https://api.search.brave.com/res/v1/web/search?q=second+highest+mountain&summary=1" \
  -H "Accept: application/json" \
  -H "Accept-Encoding: gzip" \
  -H "X-Subscription-Token: <YOUR_API_KEY>"
```

- `summary` (boolean): "enables summary key generation in web search
  results. This is required for summarizer to be enabled."
  (https://api-dashboard.search.brave.com/api-reference/web/search/get)
- The response carries `summarizer: { "type": "summarizer", "key": "..." }`
  ("The key to retrieve the full summary results") and equivalently
  `query.summary_key` ("Key to retrieve AI-generated summary for the
  query"). (same page; key shape example at
  https://api.search.brave.com/app/documentation/summarizer-search)
- `result_filter` can include `summarizer`, returned "where data is
  available and the plan has the corresponding option activated." (same
  api-reference page)

Step 2 — fetch the summary with the key (HTTP GET):

```bash
KEY='<URL_ENCODED_KEY_FROM_STEP_1>'
curl -s --compressed \
  "https://api.search.brave.com/res/v1/summarizer/search?key=${KEY}&entity_info=1" \
  -H "X-Subscription-Token: <YOUR_API_KEY>"
# variant with inline citations:
# "https://api.search.brave.com/res/v1/summarizer/search?key=${KEY}&inline_references=true"
```

- Endpoint `GET https://api.search.brave.com/res/v1/summarizer/search`,
  params `key` (required), `entity_info`, `inline_references`; header
  `X-Subscription-Token`. "Summarizer requests are **not billed** — only
  the initial web search request" is.
  (https://api-dashboard.search.brave.com/documentation/services/summarizer)
- "Inline References: Get inline citations within the summary text" via
  `inline_references=true`. (same page)

## 2. Summarizer response shape — source URLs included?

Yes. Top-level response model fields (all official):

- `type`: always `"summarizer"`. "The type of summarizer search API
  result." (https://api.search.brave.com/app/documentation/summarizer-search/responses)
- `status`: "The current status of summarizer for the given key." The API
  can "respond back with an error response based on the incompleted
  summarization request, invalid subscription keys, and rate limit
  events." (same page — i.e. poll/retry while incomplete)
- `raw`: "The raw summary message." (same page)
- `entities`: "The entities in the summary message" (list of
  SummaryEntity). (same page)
- `context`: "References based on which the summary was built." (list of
  SummaryContext). (same page)

Verdict for news-sourcing: source-article URLs come back via `context`
references (and inline citations with `inline_references=true`), so a
"summary + sources" feature is directly supported — subject to the plan
catch in §3.

## 3. Plan requirement and limits

- Legacy Summarizer: "Access to Summarizer requires a subscription to
  **Pro AI** plan."
  (https://api.search.brave.com/app/documentation/summarizer-search/responses)
  Current dashboard docs add: "Access to Summarizer is available through
  the **discontinued Pro AI plan**. Users who are subscribed to the Pro AI
  plan can continue using the API…"
  (https://api-dashboard.search.brave.com/documentation/services/summarizer)
  So: NOT the Data plan, and NOT purchasable on current pricing — Pro AI
  is grandfathered.
- Current purchasable plans (both include "$5 in free credits every
  month"):
  (https://api-dashboard.search.brave.com/documentation/pricing and
  https://brave.com/search/api/)
  - **Search** — $5.00 / 1,000 requests, 50 req/s. "Complete search
    results (URLs, text, news, images, and more), with additional LLM
    context optimized for AI."
  - **Answers** — $4.00 / 1,000 queries + $5.00 per 1M input/output
    tokens, 2 req/s. "Answers grounded on a single search or multiple
    searches", "Grounding supported by citations". The Answers service
    page states: "Access to the API is available through the **Answers
    plan**" and describes "AI-generated answers backed by real-time web
    search with verifiable citations."
    (https://api-dashboard.search.brave.com/documentation/services/answers)
- Usage-limit notes: only successful requests are counted and billed
  (rate-limit headers `X-RateLimit-Remaining`, e.g.
  https://api.search.brave.com/app/documentation/summarizer-search/response-headers);
  summarizer step-2 calls are unbilled (§1). Per-endpoint subscription
  gating exists (e.g. web-search `enable_rich_callback` "Requires `Search`
  plan", api-reference/web/search/get). Per-plan query quotas live in the
  dashboard, not the public docs — confirm News/Web inclusion for the exact
  Search-plan tier at subscribe time.
- Recommendation for blognice news-sourcing: use the **Search plan**
  (`/news/search` URLs directly, §4) and optionally the **Answers plan**
  for cited summaries. Do NOT build on legacy `/summarizer/search` — it
  requires a discontinued plan.

## 4. `/news/search` params and response shape

```bash
curl -s --compressed \
  "https://api.search.brave.com/res/v1/news/search?q=munich&count=10&country=us&search_lang=en&spellcheck=1" \
  -H "Accept: application/json" \
  -H "Accept-Encoding: gzip" \
  -H "X-Subscription-Token: <YOUR_API_KEY>"
```

(Get-started example at
https://api.search.brave.com/app/documentation/news-search/get-started.
`POST /v1/news/search` also exists:
https://api-dashboard.search.brave.com/api-reference/news/news_search/get.)

Query params (all from
https://api-dashboard.search.brave.com/api-reference/news/news_search/get):

| Param | Notes |
|---|---|
| `q` (required) | Max 400 chars / 50 words |
| `country` | 2-letter code or `ALL`; default `"US"` |
| `search_lang` | default `"en"` |
| `ui_lang` | default `"en-US"` |
| `safesearch` | `off` / `moderate` / `strict`; default `"strict"` |
| `count` | 1–50, default 20 |
| `offset` | 0–9, default 0 (paginate with `count`) |
| `freshness` | `pd` (≤24h), `pw` (≤7d), `pm` (≤31d), `py` (≤365d), or `YYYY-MM-DDtoYYYY-MM-DD` (e.g. `2022-04-01to2022-07-30`) |
| `spellcheck` | boolean, default `true` (`query.altered` holds the executed query) |
| `extra_snippets` | up to 5 additional excerpts |
| `goggles` | custom re-ranking (URL or inline definition, max 3) |

Response shape (`type: "news"`, same page):

- `query`: `{ original, altered, cleaned, spellcheck_off,
  show_strict_warning, search_operators }`
- `results[]`, each `type: "news_result"` with fields:
  - `title` (required), `url` (required) — the source-article link
  - `description`, `age`, `page_age`, `page_fetched`
  - `profile`: `{ name, url, long_name, img }` (outlet metadata)
  - `meta_url`: `{ scheme, netloc, hostname, … }`,
    `fetched_content_timestamp`, …

Verdict: `/news/search` alone satisfies "source-article URLs per story"
(`results[].url` + `results[].title` + outlet `profile`), no AI plan
needed — it sits in the Search offering ("URLs, text, news, images, and
more", https://brave.com/search/api/).
