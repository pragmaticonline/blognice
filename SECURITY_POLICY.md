# Security Policy

**blognice** is operated by Pragmatic Online Co., Ltd., Chiang Mai, Thailand.

**Last updated: August 2026**

We appreciate security researchers who help make the web safer. If you find a vulnerability in blognice, email **security@blognice.com**.

## Reporting a vulnerability

Include a clear description and impact, reproduction steps, useful screenshots or request/response logs, proof-of-concept code where appropriate, and whether you believe it is being exploited. We aim to acknowledge valid reports within 2 business days and, where a report is reproducible, provide an initial triage status within 7 days. Complex reports may take longer; we will keep you informed. English is preferred; Thai is welcome.

## Good-faith research

Please allow at least 90 days for remediation before public disclosure, unless we agree otherwise, the issue is already public, or earlier disclosure is necessary to protect users. Test only accounts and blogs you own, or custom domains where you have written authorization. Do not access, modify, or delete other users’ data; disrupt service; use social engineering, phishing, or physical attacks; or submit unverified automated-scanner output. If you act in good faith, follow this policy and applicable law, avoid privacy harm or disruption, stop testing when asked, and report promptly without public disclosure during the agreed timeline, we will not initiate civil legal action for accidental good-faith violations of this policy. This does not protect unlawful conduct or bind third parties.

## Scope

In scope: the blognice web application at `blognice.com` and `*.blognice.com`, the BlogNice API (`/api/v1/*`), authentication and sessions, tenant isolation, and API-key handling. Custom-domain blogs are in scope only where you own the domain or have written authorization.

Out of scope: clickjacking without a sensitive action, headers without practical impact, rate-limit reports without demonstrated material security, privacy, availability, or financial impact, self-XSS, social engineering, third-party provider vulnerabilities, theoretical reports without a working proof of concept, untriaged automated-scanner output, and denial-of-service testing.

## Rewards

We do not currently operate a fixed bug-bounty programme. Meaningful, responsibly disclosed reports may be recognised or rewarded at our discretion based on severity and impact. A formal programme may be introduced later.

## How we secure the platform

blognice runs on Cloudflare Workers, D1, R2, and Analytics Engine. Traffic is served over HTTPS and certificates are managed by Cloudflare. Passwords use a memory-hard hash; sessions use cryptographically random server-side tokens and are invalidated on logout; API keys are stored only as one-way hashes and shown once.

Blog data is tenant-scoped in application queries and authenticated API access. Admin access requires authentication, while staff administration is separately protected by Cloudflare Access identity checks and application role controls. Database bindings are not public. Cloudflare, Stripe, NOWPayments, and MailNice process data for the features described in the Privacy Policy under their own terms and applicable agreements.

These are high-level controls, not a guarantee that every attack is impossible. Generated AI content is not guaranteed accurate or rights-cleared.

## Incident response

If we identify a personal-data breach, we will contain it, assess the affected data and people, notify affected users and authorities where required by applicable law, and explain remediation and recommended actions where appropriate and lawful. Any 72-hour notification period applies where a specific law requires it and runs from the legally relevant point of awareness; it is not a blanket guarantee for every incident.

## Contact

Security reports: **security@blognice.com**  
Privacy questions: **privacy@blognice.com**

Pragmatic Online Co., Ltd.  
Prego Mall, 229/14 Moo 8, Tonpao, San Kamphaeng, Chiang Mai 50130, Thailand
