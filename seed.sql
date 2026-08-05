-- Demo data for the INDEX database (blog + account + membership).
-- Run with:  npm run db:seed  /  npm run db:seed:local
-- Post bodies are seeded separately into the POSTS database (seed-posts.sql).

INSERT INTO tenants (id, public_id, slug, custom_domain, title, description, created_at) VALUES
  (1, 'ggh6gvgsgj4h', 'demo', NULL, 'The Demo Blog', 'A tiny blog running on Blog Nice.', 1735689600);

-- Demo login:  demo@example.com  /  password   (change before deploying)
INSERT INTO accounts (id, email, pw_hash, created_at) VALUES
  (1, 'demo@example.com',
   'pbkdf2$100000$MeaSxHnYR1N1E/OU1FRENA==$HoTRik5F+yjFf9B7fvA9uv5/RW7S7RrVsEyz8DueD/A=',
   1735689600);

INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES
  (1, 1, 'owner', 1735689600);
