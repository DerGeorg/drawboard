-- Colour theme the user chose (SYSTEM = follow the operating system, LIGHT, DARK); follows the user to every device.
-- Structure only; the allowed values live in the application (ColorTheme), which always sets the value itself.
-- Deliberate exception to "no defaults in the DB": the DEFAULT stays so that the previous image, which does not know
-- the column, can still insert profiles after a failed rollout and rollback (same reasoning as library V5, Fable review).

ALTER TABLE user_profile ADD COLUMN theme text NOT NULL DEFAULT 'SYSTEM';
