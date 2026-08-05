-- Store the public author label on each post so attribution remains stable
-- even if a collaborator's account or membership later changes.
ALTER TABLE posts ADD COLUMN author_name TEXT;
