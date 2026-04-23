/**
 * Shared enum mappings for Madden 26 draft class generation (Node.js).
 */

// DraftPositionE enum values from M26 schema
// Verified against official CAREERDRAFT-2025_M26 (Cam Ward=0, Jeanty=1,
// W.Campbell=5, T.Booker=8, A.Carter=10, M.Graham=12, J.D-Johnson=13 etc.)
const POSITION_TO_ENUM = {
  QB:   0,
  HB:   1,
  RB:   1,
  FB:   2,
  WR:   3,
  TE:   4,
  LT:   5,
  T:    5,
  OT:   5,
  LG:   6,
  G:    6,
  OG:   6,
  C:    7,
  RG:   8,
  RT:   9,
  DE:   10,
  EDGE: 10,
  LE:   10,
  RE:   11,
  DT:   12,
  NT:   12,
  OLB:  13,
  LB:   13,
  LOLB: 13,
  ILB:  14,
  MLB:  14,
  ROLB: 15,
  CB:   16,
  FS:   17,
  S:    17,
  DB:   17,
  SS:   18,
  K:    19,
  PK:   19,
  P:    20,
  LS:   21,
};

// Dev trait values
const DEV_TRAIT = {
  Normal:  0,
  Impact:  1,
  Star:    2,
  XFactor: 3,
};

// US state abbreviation → byte value (0 = unknown)
const STATE_TO_ENUM = {
  '':   0,
  AL:   1, AK:  2, AZ:  3, AR:  4, CA:  5,
  CO:   6, CT:  7, DE:  8, FL:  9, GA: 10,
  HI:  11, ID: 12, IL: 13, IN: 14, IA: 15,
  KS:  16, KY: 17, LA: 18, ME: 19, MD: 20,
  MA:  21, MI: 22, MN: 23, MS: 24, MO: 25,
  MT:  26, NE: 27, NV: 28, NH: 29, NJ: 30,
  NM:  31, NY: 32, NC: 33, ND: 34, OH: 35,
  OK:  36, OR: 37, PA: 38, RI: 39, SC: 40,
  SD:  41, TN: 42, TX: 43, UT: 44, VT: 45,
  VA:  46, WA: 47, WV: 48, WI: 49, WY: 50,
  DC:  51,
};

// All rating fields required per prospect in prospects_rated.json
const ALL_RATING_FIELDS = [
  'overall', 'speed', 'acceleration', 'agility', 'strength', 'awareness',
  'throwPower', 'throwAccuracy', 'throwAccuracyShort', 'throwAccuracyMid',
  'throwAccuracyDeep', 'throwOnTheRun', 'throwUnderPressure', 'playAction',
  'breakSack', 'tackle', 'hitPower', 'blockShedding', 'finesseMoves',
  'powerMoves', 'pursuit', 'zoneCoverage', 'manCoverage', 'pressCoverage',
  'playRecognition', 'jumping', 'catching', 'catchInTraffic', 'spectacularCatch',
  'shortRouteRunning', 'mediumRouteRunning', 'deepRouteRunning', 'release',
  'runBlock', 'passBlock', 'runBlockPower', 'runBlockFinesse', 'passBlockPower',
  'passBlockFinesse', 'impactBlocking', 'leadBlock', 'jukeMove', 'spinMove',
  'stiffArm', 'trucking', 'breakTackle', 'ballCarrierVision', 'changeOfDirection',
  'carrying', 'kickPower', 'kickAccuracy', 'kickReturn', 'stamina', 'toughness',
  'injury', 'morale', 'personality', 'devTrait', 'unkRating1',
];

module.exports = { POSITION_TO_ENUM, DEV_TRAIT, STATE_TO_ENUM, ALL_RATING_FIELDS };
