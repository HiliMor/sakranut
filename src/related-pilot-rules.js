// Small, hand-reviewed pilot vocabulary, not an entity-resolution service.
// Other entries use the complete Wikipedia title; no surname-only expansion.
export const RELATED_RULES_VERSION = 'metadata-pilot-v1';
export const RELATED_ENTITY_RULES = Object.freeze({
  'תעתוע (סרט)': {
    aliases: ['תעתוע', 'Verity'],
    requiredAny: ['סרט', 'קולנוע', 'אן האת׳ווי', 'דקוטה ג׳ונסון'],
  },
});
