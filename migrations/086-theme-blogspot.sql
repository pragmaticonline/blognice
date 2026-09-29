-- Rename the 'classic' blog theme to 'blogspot' (INDEX database). Any blog
-- that picked the theme between migrations 085 and 086 keeps it.
-- Target: blognice.
UPDATE tenants SET theme = 'blogspot' WHERE theme = 'classic';
