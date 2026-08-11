# We Taught an AI QA Agent to Say “I Don’t Know”

## The idea was simple. The hard part was making it trustworthy.

Blognice is an open-source blogging platform, and we wanted an external AI reviewer that could inspect proposed changes without editing the repository, running deployment commands, or quietly turning an incomplete review into a green light.

We named the reviewer Zuck. Zuck runs through Muse’s `muse-spark-1.2-contributor` model, but the interesting part is not the model switch. It is the bridge around the model.

The bridge is deliberately small and explicit:

- a review prompt;
- selected files, ranges, diffs, or test output;
- a bounded request to the external model;
- a structured `PASS` or `NEEDS CHANGES` report.

The API key is supplied through `MODEL_API_KEY`; the bridge does not log it, commit it, or place it in a Worker file. Zuck receives selected text through an external API, not repository access. For a single-packet review, the bridge makes one external request; larger reviews make one request per bounded packet plus one bounded synthesis request. It does not write files, run shell commands, or deploy anything. Redaction is bounded and heuristic, so the safest policy is still to exclude sensitive files and never submit secrets intentionally.

## The first problem was context

An AI reviewer cannot review code it never receives. Our first bounded implementation could submit only part of a large file. That created a dangerous ambiguity: Zuck might see enough code to sound confident while missing the branch that mattered.

The bridge now makes completeness explicit. It marks omitted and truncated context, reserves space for a manifest, rejects excluded paths and symlink escapes, and refuses to treat incomplete context as a confirmed pass.

When a review is too large, the bridge creates line-aware packets. Each packet states its scope and preserves original line numbers. Zuck reviews the packets individually, then performs a separate bounded synthesis over the packet reports. A multipart result can pass only when synthesis finds no unresolved critical or high finding, no confirmed packet-local defect, no failed or incomplete packet, and no incomplete synthesis context.

That synthesis stage was important. Independent packet passes do not prove that two files work together.

## The second problem was redaction

Secret protection sounds straightforward until the thing being reviewed is source code and prose. A first redactor was too eager: words and identifiers such as `token`, `authorization`, and `safeApiKey` could disappear from otherwise harmless review context.

That matters because a security review needs to see the security logic. It is not useful to hide every variable whose name contains “key”.

We tightened the rules around credential-shaped values and preserved source syntax when replacing literals. Quoted strings keep their delimiters. Template literals remain valid. Trailing comments survive. Ordinary words remain readable, while API keys, credential-bearing URLs, JWTs, PEM blocks, and other documented secret patterns are removed.

The tests deliberately include both sides of the boundary: ordinary prose that must survive and documented credential-shaped patterns that must not. The redactor is a defense-in-depth filter, not a promise that arbitrary secrets can safely be submitted.

## The tests caught a test problem

One of the most useful findings was about our own regression test. A test intended to verify redaction had placed secret-shaped values directly in source literals. The bridge redacted those literals before Zuck saw the test, so the assertions could look correct while proving almost nothing.

We rebuilt the fixtures at runtime from separated fragments. The local test still exercises the real values, but the source submitted for review no longer contains a complete credential pattern that the bridge will pre-redact.

That was a good reminder: tests are evidence too, and AI reviewers need to be able to inspect the evidence.

## The false `PASS` we almost allowed

BIG found a more serious edge case. A packet transport failure was represented as a medium finding. The final aggregation only treated critical and high findings as hard blockers, so a later successful synthesis could theoretically turn an incomplete multipart review into `PASS`.

The fix was an explicit packet-failure flag. Any failed or incomplete packet now blocks a final pass, regardless of the severity of the diagnostic message. A regression test simulates exactly one failed packet followed by a successful synthesis and requires `NEEDS CHANGES`.

This is the kind of defect that is easy to miss when reviewing only the happy path.

## Why we used a team

Zuck is useful, but Zuck is not the only voice in the process.

BIG provides a deliberately adversarial second opinion. Tackleberry focuses on security boundaries, secret handling, and failure modes. Steve reviews product clarity and whether the story makes sense to a reader. The deterministic test suite remains the final local authority for behavior we can check precisely.

The agents do not replace one another. They create pressure from different directions. Zuck may identify a missing qualification in a draft; BIG may notice that a test is vacuous; Tackleberry may ask whether a failure path leaks too much; and the implementation still has to pass ordinary tests.

## What we learned

The valuable feature was not “ask an AI to review code”. The valuable feature was making the review bounded, observable, read-only, secret-safe, and honest about uncertainty.

An external reviewer should be able to say:

> I cannot verify this because the relevant context was omitted.

That is not a failure of the reviewer. It is a successful refusal to manufacture confidence.

For Blognice, the practical workflow is now simple:

```text
make a change
  -> run deterministic tests
  -> ask Zuck for a bounded review
  -> ask BIG and Tackleberry to challenge the result
  -> fix confirmed findings
  -> rerun tests and review
  -> merge only when the evidence agrees
```

The bridge is still a small tool, and its reports are still advice rather than proof. But it gives us a repeatable way to bring an external AI reviewer into an open-source project without pretending that an incomplete answer is certainty.

## Review record

Final review round: 2026-08-11. The review context was this draft plus the
current bridge implementation at commit `e337fc1` (`Harden Zuck QA packet
failure handling`).

- BIG: **PASS**. Confirmed the model, external API and environment-key
  handling, bounded packets and synthesis, redaction, path exclusions,
  read-only behavior, and the incomplete-packet PASS guard.
- Tackleberry: **PASS**. Confirmed the external-transmission disclosure,
  secret handling, excluded paths and symlink protection, read-only scope, and
  the absence of absolute security guarantees.
- Zuck: **PASS**. Confirmed the draft's factual accuracy, external API
  disclosure, bounded heuristic redaction, packet/synthesis safeguards, and
  reader-facing clarity.
- Steve: not part of this review round; no Steve review is being implied here.

That is the part other developers may find most useful: not the name of the model, but the engineering around it.
