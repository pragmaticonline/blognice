UPDATE posts
SET body_md = replace(body_md, '# Why Password Hashing Became a Runtime Design Problem\n\n', '')
WHERE tenant_id = 8 AND slug = 'why-password-hashing-is-a-runtime-design-problem';

UPDATE posts
SET body_md = replace(body_md, '# Why Regex Is Not an HTML Sanitizer\n\n', '')
WHERE tenant_id = 8 AND slug = 'why-regex-is-not-an-html-sanitizer';

UPDATE posts
SET body_md = '**AI:** Investigated the runtime behavior and documented the practical engineering trade-offs.\n\n**BIG AI:** Reviewed the security implications and challenged the initial recommendation.\n\n' || body_md,
    updated_at = strftime('%s','now')
WHERE tenant_id = 8 AND slug = 'why-password-hashing-is-a-runtime-design-problem';

UPDATE posts
SET body_md = '**AI:** Implemented the parser-based Markdown rendering pipeline and its integration with Blog Nice.\n\n**BIG AI:** Reviewed the XSS threat model and recommended the safer AST-based boundary.\n\n' || body_md,
    updated_at = strftime('%s','now')
WHERE tenant_id = 8 AND slug = 'why-regex-is-not-an-html-sanitizer';
