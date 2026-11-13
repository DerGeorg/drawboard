/** The longest emoji value a block may hold, in UTF-16 units (a family ZWJ sequence is 11). */
export const MAX_EMOJI_LENGTH = 32;

/** What replaces an invalid value on screen (props come from other people, S5). */
export const EMOJI_FALLBACK = '❔';

// An emoji tag sequence (England, Scotland, Wales): the black flag, tag characters, cancel tag.
// Tag characters are valid nowhere else.
const TAG_SEQUENCE = '\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F}';
// One pictograph with its trailing variation selector and skin tone modifiers.
const SIMPLE =
  '[\\p{Extended_Pictographic}\\p{Regional_Indicator}](?:\\uFE0F|\\p{Emoji_Modifier})*';
const PICTOGRAPH = `(?:${TAG_SEQUENCE}|${SIMPLE})`;
// A keycap (1️⃣, #️⃣, *️⃣): base character, optional variation selector, combining keycap.
const KEYCAP = '[0-9#*]\\uFE0F?\\u20E3';
const EMOJI = new RegExp(`^(?:${KEYCAP}|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*)+$`, 'u');

/**
 * True if `value` is one or more emojis and nothing else: 1 to 32 UTF-16 units, made only of
 * pictographs, regional indicators (flags), keycaps and the joiners and modifiers that belong to
 * them - so no whitespace, no control characters, no letters and no markup (architecture 3.13).
 */
export function isValidEmoji(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_EMOJI_LENGTH &&
    // no lone surrogates (they would not survive UTF-8 on the way to the server)
    (value as string & { isWellFormed(): boolean }).isWellFormed() &&
    EMOJI.test(value)
  );
}
