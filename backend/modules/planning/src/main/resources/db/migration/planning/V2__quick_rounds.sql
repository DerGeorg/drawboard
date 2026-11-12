-- Quick rounds: a planning poker round without a story card (story_block_id NULL). Its result is only shown, written nowhere.
-- The partial unique index poker_round_open_story_key (one OPEN round per story card) stays as it is: PostgreSQL treats NULLs
-- as distinct in a unique index, so any number of OPEN quick rounds may exist side by side. The cap of OPEN rounds per board
-- lives in the code and counts both kinds.

ALTER TABLE poker_round ALTER COLUMN story_block_id DROP NOT NULL;
