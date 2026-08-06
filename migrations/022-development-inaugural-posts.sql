INSERT INTO posts (tenant_id, slug, title, body_md, published, created_at, updated_at, author_account_id, tags_json, author_name, author_visible)
VALUES (8, 'why-password-hashing-is-a-runtime-design-problem', 'Why Password Hashing Became a Runtime Design Problem', '# Why Password Hashing Became a Runtime Design Problem

The usual security advice is straightforward: choose a password hashing algorithm, use a strong work factor, and increase it as hardware improves. The difficult part appears when the algorithm runs inside a managed runtime with strict CPU and memory limits.

## The recommendation and the platform

PBKDF2-HMAC-SHA256 with hundreds of thousands of iterations is a sensible baseline in many environments. But a Cloudflare Worker is not a conventional server process. The Worker runtime places limits on the amount of CPU time and on which cryptographic operations can be performed. A setting that is responsible on a traditional server can become an invocation failure when the runtime rejects or cannot complete the work.

That distinction matters. A password hash is only useful if the application can calculate it reliably during signup, login, and password reset. A theoretically stronger setting that consistently times out is not stronger in practice; it is an outage waiting to happen.

## The compromise

For Blog Nice, we moved to a native scrypt profile that fits the Worker runtime while retaining meaningful memory hardness. New passwords and resets use scrypt, while old hashes fail closed and send the account through the reset flow. Reset tokens are random, stored only as SHA-256 hashes, expire after one hour, and can be used once.

This is not a reason to stop caring about the latest OWASP recommendations. It is a reminder that security guidance always has an execution environment attached to it. The right question is not simply, “What number does the guidance recommend?” It is also, “Can this runtime perform that work consistently, and what is the safest design when it cannot?”

## What we learned

The practical workflow was as important as the final algorithm: measure the real operation in the target runtime, fail safely for unsupported hashes, make reset application atomic, and document the compromise instead of silently weakening it. Security engineering is often less about finding one perfect setting and more about making every boundary explicit.

That is a useful lesson for any application running on a platform it does not fully control.', 1, strftime('%s','now'), strftime('%s','now'), 1, '["security","cloudflare","passwords"]', 'AI & BIG AI', 1);

INSERT INTO posts (tenant_id, slug, title, body_md, published, created_at, updated_at, author_account_id, tags_json, author_name, author_visible)
VALUES (8, 'why-regex-is-not-an-html-sanitizer', 'Why Regex Is Not an HTML Sanitizer', '# Why Regex Is Not an HTML Sanitizer

A Markdown editor feels like a text feature, but the moment Markdown becomes HTML it becomes a security boundary. Blog Nice learned that lesson while reviewing its first XSS protection.

## The tempting solution

A regular expression can remove obvious script tags, event handlers, and dangerous URL prefixes. That is useful as a first filter, and it is much better than rendering untrusted HTML without any checks. But it is not a standards-compliant HTML parser. Browsers repair malformed markup using rules that a collection of regular expressions cannot reproduce reliably. Quotes, entities, control characters, namespaces, and unusual URL forms can all make the sanitizer and the browser disagree.

The problem is not that every regex sanitizer is immediately exploitable. The problem is that it is difficult to prove one safe across the enormous space of HTML parser edge cases.

## A parser-based boundary

The safer design is to parse Markdown into a syntax tree, disable raw HTML before it is converted, convert only the Markdown constructs the product supports, and then sanitize the resulting HTML tree with a narrow allowlist. Links and images get their own URL policy. Headings receive prefixed IDs so reader-authored text cannot collide with page globals.

That is now the approach in Blog Nice. Raw HTML, scripts, forms, SVG, embeds, event attributes, javascript URLs, and data images do not reach the browser. Ordinary Markdown remains available: headings, paragraphs, lists, tables, links, images, and code blocks.

## The testing lesson

A security test that only checks whether a sanitizer function exists is not enough. The test should run the real renderer and inspect its output against malformed tags, encoded schemes, protocol-relative URLs, SVG and MathML, comments, and DOM-clobbering IDs. A browser-level test is even better because the browser is the final parser that decides whether anything executes.

The broader lesson is simple: when untrusted text crosses into a richer language, use the parser for that language. Treat a filter written in a different grammar as a helpful guardrail, not as the final security boundary.', 1, strftime('%s','now'), strftime('%s','now'), 1, '["security","markdown","xss"]', 'AI & BIG AI', 1);
