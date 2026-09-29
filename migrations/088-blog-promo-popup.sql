-- Per-blog promo popup (INDEX database). Owner-composed modal with an
-- optional image, Markdown body, and CTA button; shown on the home page
-- or every public page depending on promo_placement.
-- Target: blognice.
ALTER TABLE tenants ADD COLUMN promo_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN promo_placement TEXT NOT NULL DEFAULT 'home';
ALTER TABLE tenants ADD COLUMN promo_image TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN promo_body_md TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN promo_cta_text TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN promo_cta_url TEXT NOT NULL DEFAULT '';
