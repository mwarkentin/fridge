-- How far each sign-in has caught up, for notifications and for New.
--
-- people.seen was the newest comment the page had shown someone, so newer
-- comments were marked New. Notifications are about new art and stickers
-- too, which have no comment id, so how far someone has caught up becomes a
-- time instead: everything on the fridge before seen_at has been seen. Both
-- the walls' New marks and the bell's count go by it (worker.js,
-- notifications, and app.js).
--
-- Whoever had looked before starts from when they last opened the fridge
-- (updated_at moved with seen), so their first bell shows what came since.
-- seen stays, unread, so the Worker deployed before this one keeps working
-- while this one deploys after the migration.
ALTER TABLE people ADD COLUMN seen_at TEXT; -- like created_at: YYYY-MM-DD HH:MM:SS, UTC
UPDATE people SET seen_at = updated_at WHERE seen IS NOT NULL;
