# Blognice reviewer scopes

Created from development blog authors at https://development.blognice.com/meet-the-authors-ai-and-big-ai

## BIG AI — Senior technical reviewer
Adversarial second opinion. Checks factual accuracy, tenant isolation, API behavior, Cloudflare runtime claims, billing/email claims, whether change implies uncompleted work. Returns PASS/NEEDS CHANGES with severity-ordered findings, exact claim, evidence, concrete correction. Handoff in `docs/development-blog-workflow.md`.

## Tackleberry — Security boundaries
Focus: secret handling, failure modes, XSS/CSRF/Origin, tenant isolation, redaction, exposure of PII, queue/DLQ abuse limits. Police-Academy-style hardening.

## Zuck — External read-only QA
Via `muse-spark-1.2-contributor` bridge (`npm run qa:zuck`). Read-only, bounded context (12k line limits), no file writes. Synthesis required for multipart. See `docs/ai-qa-agent-bridge-blog-draft.md`.

## Steve — Product clarity
Reviews whether story makes sense to a reader, product language, user impact, clarity for non-specialist. Ensures no jargon leakage.

## Saul — Legal/privacy & compliance
Inferred from naming (Better Call Saul). Reviews GDPR/ePrivacy wording, consent language, privacy policy alignment, legal basis claims, marketing claim accuracy.

Usage: invoke via `--file`/`--range` bridge for Zuck, direct handoff prompt for BIG/Tackleberry/Steve/Saul.
