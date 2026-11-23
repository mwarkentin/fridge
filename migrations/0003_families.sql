-- Which family each kid is in, by the id of a family in the FAMILIES Worker
-- secret, which infra writes from its fridge_people.auto.tfvars. Parents can
-- change only the kids in their own families, and those kids' pieces. NULL
-- means the kid isn't in a family, so any parent can change them, as before
-- families. A family that's no longer in FAMILIES counts as NULL too.
ALTER TABLE kids ADD COLUMN family TEXT;
