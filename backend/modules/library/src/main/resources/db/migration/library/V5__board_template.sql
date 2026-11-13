-- Template boards: a board can be marked as a template, listTemplates offers it as a starting point.
-- Structure only; who may change the flag lives in LibraryService, and the application always sets the value itself.
-- Deliberate exception to "no defaults in the DB": the DEFAULT stays so that the previous image, which does not know
-- the column, can still insert boards after a failed rollout and rollback (Fable review).

ALTER TABLE board ADD COLUMN template boolean NOT NULL DEFAULT false;

-- listTemplates reads the candidates of one caller: own boards (owner_id), boards below shared folders (folder_id) and
-- directly shared boards (the primary key), always template AND not in the trash, newest first. Templates are rare, so
-- the partial indexes stay tiny.
CREATE INDEX board_template_owner_idx ON board (owner_id, updated_at, id) WHERE template AND deleted_at IS NULL;
CREATE INDEX board_template_folder_idx ON board (folder_id, updated_at, id) WHERE template AND deleted_at IS NULL;
