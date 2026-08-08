# Cookie and Local Storage Policy

**blognice** is operated by Pragmatic Online Co., Ltd., Thailand.

**Last updated: August 2026**

## The short version

blognice uses one strictly necessary first-party session cookie for signed-in administration. Public pages do not use analytics cookies or advertising cookies. Public pages may use browser local storage for theme preference, analytics consent, and (only when permitted) a random pseudonymous visitor identifier. Local storage is not a cookie, but it is still described here for clarity.

## The admin session cookie

`bn_session` keeps a blogger signed in to the admin. It is an opaque random token, contains no readable personal information, and is marked HttpOnly, Secure in production, SameSite=Lax, and scoped to the site. It expires after about 30 days or when the session is revoked or you log out. Readers visiting public blogs do not receive this cookie from blognice.

## Public local storage

Public pages may store:

- `blognice-theme`, to remember light/dark theme preference.
- `blognice-analytics-consent-v1`, to remember whether optional analytics was allowed or declined.
- `blognice-visitor`, a random first-party identifier used only for aggregate returning-visit counts. It is created only when analytics is permitted and is removed when analytics is declined or withdrawn.

The visitor identifier is pseudonymous, not an account identity, and is not used for advertising or cross-site tracking. Analytics may also receive page path, approximate country, broad device category, browser family, and audio-play events. Where consent is required, optional analytics starts only after “Allow analytics.” The decision uses Cloudflare’s approximate country signal and can be affected by VPNs, travel, or routing.

## Third-party payment cookies

Stripe may set its own session and fraud-prevention cookies when you open Stripe-hosted Checkout or billing pages. NOWPayments may use similar provider cookies on its hosted cryptocurrency payment flow. These are not blognice cookies and are controlled by the relevant provider. See Stripe’s and NOWPayments’ privacy and cookie notices for details.

## Your choices

You can block or clear cookies and local storage in browser settings. Blocking `bn_session` prevents admin sign-in but does not affect public reading. On public pages, open **Analytics preferences** to allow or decline optional analytics; declining does not affect reading, listening, subscribing, or other public features. Clearing storage resets the preference and theme choice.

## Changes and contact

We will update this policy if we add cookies or materially change local-storage behavior. Questions: privacy@blognice.com.

Pragmatic Online Co., Ltd., Prego Mall, 229/14 Moo 8, Tonpao, San Kamphaeng, Chiang Mai 50130, Thailand.
