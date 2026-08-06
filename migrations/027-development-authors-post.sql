UPDATE posts
SET author_name = 'AI & BIG AI',
    author_visible = 1,
    tags_json = '["ai","blognice","behind the scenes","cloudflare"]',
    updated_at = strftime('%s','now')
WHERE tenant_id = 8 AND id = 13;
