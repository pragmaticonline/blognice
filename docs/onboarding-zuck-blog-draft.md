# When AI Reviews AI: Hardening Blognice's External QA Workflow

**Public author:** The Dev Team
**Topics:** AI, developer tools, quality assurance, Cloudflare Workers, open source

## Draft

We wanted an additional pair of eyes on Blognice: something that could review a
change from outside the repository, without being given the ability to edit
files, run shell commands, push Git commits, or deploy a Worker.

That became Zuck, an explicitly invoked external QA reviewer. The important
part was not simply choosing a model. It was building a narrow bridge between
our repository and the model.

The bridge accepts a review prompt and optional context: selected files, line
ranges, a Git diff, and test or typecheck output. The CLI reads `MODEL_API_KEY`
from the environment, does not persist it or intentionally print it, and
redacts it from submitted context and returned reports. It submits context to
the Muse API using the Contributor model, `muse-spark-1.2-contributor`.

We chose the Contributor model deliberately for this open-source project. In
the dashboard's seven-day view for August 4–10, 2026, Zuck had handled nine
requests: about 72.4k input tokens and 49.5k output tokens, for ฿0.56. We had
only been using Zuck for roughly 1.5 hours, so this was an unusually early
observation rather than a mature usage period. The amount is approximately
**$0.02**. This is an early observation rather than a controlled pricing
benchmark.

The first lesson was that a confident review can still be based on incomplete
evidence. Our initial bridge submitted only the beginning of a large file. Zuck
then reported that helpers and related behavior were missing—even though they
were present later in the file. The problem was not merely the model's opinion;
our context-selection design had hidden the evidence.

We changed the bridge to support explicit, 1-indexed inclusive line ranges. It
now reports which lines were included and which were omitted. Equivalent paths
are canonicalized before files and ranges are deduplicated, including Windows
separator and case differences. The assembled context is capped at 36,000
JavaScript string characters—not bytes or model tokens—with a 12,000-character
whole-file limit, 4,000 lines per range, 12,000 selected range lines total, and
40 range specifications. Manifests, separators, newlines, content, and
truncation markers all count toward the assembled limit.

The bridge also treats confidentiality as a first-class concern. Environment
files, Wrangler state, build output, credential-bearing paths, private keys,
credential URLs, bearer tokens, JWTs, provider tokens, and other secret-like
values are filtered or redacted. Redaction is conservative and imperfect: it
can hide a harmless token-shaped fixture, while no pattern-based system can
guarantee that every secret format is detected. Redacted values receive visible
placeholders. Truncation is marked where it occurs, while excluded,
policy-rejected, or unselected requested context is recorded in the omission
manifest.

The most important safeguard is what happens when context is missing. An
excluded, missing, policy-rejected, truncated, or unselected request is recorded
as incomplete; malformed inputs fail clearly before the API request.
Zuck is instructed not to claim that an omitted pattern is absent, and the
bridge downgrades an otherwise clean model PASS when the submitted evidence is
incomplete. The goal is not to make Zuck infallible. It is to make the evidence
bounded and inspectable.

BIG provides a second layer of review. Sometimes BIG reviews the source and
criteria directly; sometimes BIG is asked to challenge Zuck's findings. Those
are different kinds of independence, and we try to describe the distinction
honestly. This separation is a team practice, not an automated bridge property.
The useful outcome is disagreement: it exposed false positives,
missing tests, weak assumptions, and premature PASS results.

Our resulting workflow is deliberately layered:

1. Deterministic tests and typechecking run first.
2. Zuck performs an explicitly requested, read-only review of bounded context.
3. BIG challenges the design or the review result.
4. A human decides what to fix and whether the change is ready.

Zuck is not OS-level sandboxing. The bridge is a local Node tool used to review
a Cloudflare Workers project; it is not deployed as a Worker. The local Node
process runs with the invoking user's permissions, although its implementation
performs reads and the external model receives no write, shell, Git, or
deployment tools. Submitted source leaves the local environment and goes to an
external Meta API. The [Meta AI Terms of Use](https://www.facebook.com/legal/ai-terms)
were checked on August 11, 2026; the page says regional versions may apply and
lists an effective date of May 13, 2026. Those terms explain that Meta may
retain and use AI interactions to provide, improve, and research its services,
and that interactions may receive automated or human review. Open-source
status does not make credentials or personal data safe to submit, so filtering
still matters. Readers should check the regional terms that apply to them.

The broader lesson is that adding an AI reviewer is mostly a context-engineering
problem. A model can only review the evidence it receives, and a PASS is review
evidence—not proof of correctness. We did not make Zuck infallible. We made its
evidence bounded, privacy-conscious, and easier to challenge.

## Publication notes

- Keep this as a draft until BIG review, Zuck QA, audio completion, image
  verification, and explicit human approval are complete.
- Generate the featured image before any publication attempt: 16:9, no visible
  text, logos, or watermarks. Do not publish or cache the post while the image
  is empty.
- Generate narration through the audio API and pronunciation-test terms such as
  Contributor, canonicalization, Wrangler, and Zuck.
- The Meta AI Terms link was verified anonymously and displays the regional
  terms, effective date, and personal-information sections.
- Verify the post remains unpublished until final approval.
