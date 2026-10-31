-- Phase 7 — suppression différée de la fonctionnalité classroom (routes et
-- logique applicative déjà retirées en Phase 3).

ALTER TABLE clips DROP COLUMN IF EXISTS classroom_id;
ALTER TABLE users DROP COLUMN IF EXISTS classroom_id;
DROP TABLE IF EXISTS classrooms;
