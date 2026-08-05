-- Blog-specific public author names. Email addresses remain private account data.
ALTER TABLE memberships ADD COLUMN display_name TEXT;
