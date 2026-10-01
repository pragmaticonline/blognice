# Blogger / Blogspot dissatisfaction research

Researched: 2026-09-28. Scope: signs Google deprioritized Blogger. Dated 2022+ preferred; older items flagged.

## 1. Stagnant features / UI neglect

- No major Blogger updates in years; 2025 survey lists cons as limited customization, no full ownership, outdated features, poor scalability (https://www.exeideas.com/2025/07/is-google-blogger-blogspot-dead.html).
- Last widely covered Blogger change was 2018 removals: third-party gadgets, Next Blog, polling widget (https://techcrunch.com/2018/05/15/blogger-gets-a-spring-cleaning-web20-wants-its-headlines-back).
- Google deprecated FeedBurner email subscriptions and Blogger's FollowByEmail widget during 2021 infra migration (https://techcrunch.com/?p=2138519).
- Blogger lacks built-in SEO plugins/extensions peers have (FAQ/star-rating markup); galleries and audio need third-party widgets (https://www.pitiya.com/blogger-alternatives.html).
- Blogger cannot serve arbitrary root files, blocking IndexNow key verification entirely (https://dev.to/just_a_side_project/i-registered-this-blog-with-three-search-engines-in-one-afternoon-and-discovered-indexnow-doesnt-9i9).

## 2. Custom-domain / HTTPS pain

- Official setup requires 2 CNAMEs (incl. per-account security CNAME), 4 A-records for naked redirect, 1h+ wait, up to 24h redirect; CAA must include letsencrypt.org or SSL fails (https://support.google.com/blogger/answer/1233387?hl=en).
- Recurring thread: "HTTPS not available for custom domain", fix is toggle HTTPS off/on and wait for cert (https://support.google.com/blogger/thread/448219564?hl=en&msgid=448221952).
- Recurring thread: HTTPS shows "Available" but no certificate is served on custom domain (https://support.google.com/blogger/thread/440982442?hl=en&msgid=441218388).
- Recurring thread: custom domain HTTP works but HTTPS unavailable; must toggle slider and wait for Google cert (https://support.google.com/blogger/thread/448450490?hl=en&msgid=448457142).
- Recurring thread: naked-domain redirect to www times out despite correct A-records (https://support.google.com/blogger/thread/219147526/naked-domain-redirect-to-www-times-out?hl=en).
- Feb 2024 Cloudflare thread: Blogger custom-domain site stuck "Not Secure", Google setup unfinished (https://community.cloudflare.com/t/unabe-to-add-custom-domain-to-blogger/622049).
- Thread reports custom-domain redirect errors affecting Googlebot crawling (https://support.google.com/blogger/thread/458306135?hl=en&msgid=458466694).

## 3. SEO / spam / indexing issues

- Thread: Blogger sitemap.xml generates invalid URLs with hostname missing (https://support.google.com/blogger/thread/452512517?hl=en&msgid=452546562).
- Community guide: Search Console "redirect error" FAQs caused by Blogger's automatic `?m=1` mobile redirects; requires per-URL live testing (https://support.google.com/blogger/community-guide/325142055).
- 2019 report quotes Google engineers that Blogspot pharma spam was tolerated to grow usage ("deal with it on the search side but let the pharma spam go on blogspot") (https://www.searchenginejournal.com/google-tolerated-spam/304611/).
- Google let blogspot.in expire June 2020; ~4.4M URLs broke and domain was resold for $5,999 (2020, pre-window but high-severity) (https://www.bleepingcomputer.com/news/google/risky-blogspotin-domain-for-sale-after-google-fails-to-renew-it/).

## 4. Reliability / trust incidents

- Aug 2026: false positive locked hundreds of legitimate Blogger sites for "Malware and Similar Malicious Content"; some deleted; began Aug 4 (https://www.bleepingcomputer.com/news/google/google-blogger-locks-hundreds-of-blogs-in-malware-false-positive/).
- Same incident summarized: hundreds locked, some deleted, per BleepingComputer (https://www.scworld.com/brief/google-mistakenly-locks-hundreds-of-blogger-websites).
- Affected blogs spanned custom domains and blogspot subdomains; remedy was "Request Review" with no published restore timeline (https://www.abijita.com/google-confirms-blogger-bug-behind-mass-malware-false-positives-restoration-underway/).

## 5. Support quality

- Blogger Help Community front page states it is "staffed by volunteers who do not work for Google" (https://support.google.com/blogger/community?hl=en).
- Blogger Help's "Need more help?" path is "Post to the help community / Get answers from community members" (https://support.google.com/blogger/?hl=en).
- Product Experts Program terms: experts are independent contractors, not employees or agents, unpaid (https://support.google.com/communities/answer/9717995?hl=en).

## 6. Shutdown fears / migration outflow

- 2025 analysis: Google has not announced shutdown, but years without major updates drive survival speculation (https://www.exeideas.com/2025/07/is-google-blogger-blogspot-dead.html).
- WordPress.com maintains a first-party Blogger importer path (Tools > Import) for posts, comments, users (https://wordpress.com/support/import/).
- WordPress.org ships an official Blogger Importer plugin consuming Blogger XML export (https://en-ca.wordpress.org/plugins/blogger-importer/).
- Blogger-to-WordPress guides center on XML export, permalink matching, and 301-redirect plugins, indicating steady outflow demand (https://www.bluehost.com/blog/blogger-wordpress-transfer/).
