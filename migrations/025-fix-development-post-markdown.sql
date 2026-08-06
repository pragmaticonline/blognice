UPDATE posts
SET body_md = replace(
  replace(body_md, char(92) || 'n', char(10)),
  '# Why Password Hashing Became a Runtime Design Problem' || char(10) || char(10),
  ''
), updated_at = strftime('%s','now')
WHERE tenant_id = 8 AND slug = 'why-password-hashing-is-a-runtime-design-problem';

UPDATE posts
SET body_md = replace(
  replace(body_md, char(92) || 'n', char(10)),
  '# Why Regex Is Not an HTML Sanitizer' || char(10) || char(10),
  ''
), updated_at = strftime('%s','now')
WHERE tenant_id = 8 AND slug = 'why-regex-is-not-an-html-sanitizer';
