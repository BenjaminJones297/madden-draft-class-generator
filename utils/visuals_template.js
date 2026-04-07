/**
 * Default CharacterVisuals JSON blob for a generic prospect.
 * Script 2 (extract_calibration.js) will also save a real visuals blob from
 * the 2025 launch class to data/raw/default_visuals.json, which script 6
 * prefers over this hardcoded fallback.
 *
 * Structure mirrors what Madden 26 stores in the MAX_VISUALS_SIZE (4096 byte) slot.
 */

const DEFAULT_VISUALS = {
  "PLYR_EYEBROW": 0,
  "PLYR_EYEBROWCOLOR": 0,
  "PLYR_HAIR": 0,
  "PLYR_HAIRCOLOR": 0,
  "PLYR_SKINTONE": 3,
  "PLYR_FACEID": 0,
  "PLYR_HELMETTYPE": 0,
  "PLYR_EYEBLACK": 0,
  "PLYR_MOUTHPIECE": 0,
  "PLYR_VISOR": 0,
  "PLYR_TOWEL": 0,
  "PLYR_SLEEVELENGTH": 0,
  "PLYR_RIGHTARM": 0,
  "PLYR_LEFTARM": 0,
  "PLYR_RIGHTHAND": 0,
  "PLYR_LEFTHAND": 0,
  "PLYR_RIGHTLEG": 0,
  "PLYR_LEFTLEG": 0,
  "PLYR_LEFTSHOE": 0,
  "PLYR_RIGHTSHOE": 0,
  "PLYR_SOCK": 0,
  "PLYR_STOCKINGS": 0,
  "genericHeadAssetName": ""
};

module.exports = { DEFAULT_VISUALS };
