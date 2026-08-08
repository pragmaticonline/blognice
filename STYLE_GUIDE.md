# blognice style guide

This is the default reference for new pages and UI changes. The brand name is always lowercase: `blognice`.

## Product character

Quiet editorial design: readable, fast, calm, and unornamented. Use thin rules, restrained color, modest rounded corners, and no gradients or decorative chrome.

## Typography

- Public reading: a warm system serif (`Charter`, `Iowan Old Style`, `Palatino Linotype`, `Georgia`) at roughly 1.3rem with 1.58 line-height.
- Public headings and metadata: system sans, with clear hierarchy and compact metadata.
- Marketing: use its established display serif and neutral sans pairing; do not add a new font family for individual sections.
- Admin and staff: system sans, approximately 15px/1.5.
- Legal pages: readable serif body at 17–18px, sans headings.
- Avoid ad-hoc inline font sizes; add or reuse shared tokens instead.

## Color and themes

Use semantic tokens rather than literal colors: background, ink, muted text, rule, accent, danger, and focus. Public tenant pages use the tenant-selected accent; validate it for readable text and controls. Light and dark themes must use the same token names and a persisted sun/moon control. Do not introduce a separate hard-coded green for a new page.

## Layout and spacing

- Use a shared spacing scale: 4, 8, 12, 16, 24, and 32px.
- Public reading measure: about 48rem, with 1.4rem minimum side gutters.
- Marketing: wide layout, approximately 82.5rem maximum.
- Admin: use the existing wide dashboard/context-bar layouts; keep tables horizontally scrollable on small screens.
- Staff: approximately 1120px with 28px gutters.
- Legal/auth pages: approximately 800px maximum, with generous reading spacing.

## Controls and icons

- Public controls may be compact pills; admin and staff controls are 6–7px rounded bordered rectangles.
- Provide consistent primary, ghost, danger, disabled, loading, and focus states.
- Icon-only controls need an accessible label and title, with a minimum 44px target where practical.
- Use simple inline SVG icons. Do not use emoji as functional UI icons.
- Use one focus treatment everywhere: a 2px accent outline with a 2–3px offset.

## Accessibility and responsive behavior

Respect reduced motion. Use semantic headings and labels, keyboard-visible focus, `aria-live` for asynchronous status, and dialog focus/escape behavior where dialogs exist. Never communicate status by color alone. Public and admin layouts should stack or collapse around 640–720–900px breakpoints; staff pages must also stack cleanly at mobile widths.

## Page shells

- Tenant public shell: publication masthead, tenant accent, Subscribe/RSS/theme controls, analytics preferences, and publication content.
- Marketing homepage: global blognice navigation, product explanation, pricing, examples, and clear signup/login CTAs.
- Admin: global bar, blog context switcher, grouped sidebar, and account/billing controls.
- Staff: separate privileged shell using the same brand tokens, without public marketing CTAs.
- Privacy/legal: restrained global wordmark, theme toggle, footer links to Privacy/Terms/Security/Contact, and Analytics preferences. Do not include tenant Subscribe/RSS or owner controls.

## Priorities for future cleanup

1. Consolidate shared color and theme tokens across public, admin, staff, and legal surfaces.
2. Remove inline-style drift and hard-coded accent variants.
3. Add persisted theme behavior and complete mobile/keyboard states to staff and legal pages.
4. Replace remaining emoji functional icons with SVG.
5. Standardize global legal navigation and footer links.
6. Recheck contrast whenever a tenant chooses a custom accent or a status badge is added.
