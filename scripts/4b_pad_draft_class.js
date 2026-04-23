/**
 * Script 4b — Pad draft class to TARGET_TOTAL prospects.
 *
 * Node.js port of scripts/4b_pad_draft_class.py
 *
 * Reads data/prospects_rated.json, adds filler prospects with realistic names,
 * measurables, and position-appropriate Madden ratings to reach at least
 * TARGET_TOTAL prospects, then writes the padded file back.
 *
 * Usage:
 *     node scripts/4b_pad_draft_class.js
 */

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR     = path.join(PROJECT_ROOT, "data");
const INPUT_FILE   = path.join(DATA_DIR, "prospects_rated.json");
const OUTPUT_FILE  = INPUT_FILE;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TARGET_TOTAL = 300;
const SEED = 42;

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);

function randInt(lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function randFloat(lo, hi) {
  return lo + rand() * (hi - lo);
}

function randChoice(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// ---------------------------------------------------------------------------
// Position targets
// ---------------------------------------------------------------------------
const POSITION_TARGETS = {
  QB: 15, HB: 20, FB: 5, WR: 40, TE: 15,
  T: 25, G: 15, C: 10,
  DE: 30, DT: 20, OLB: 20, MLB: 15,
  CB: 35, FS: 15, SS: 15,
  K: 5, P: 5, LS: 5,
};

// ---------------------------------------------------------------------------
// Name pools
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  "James","John","Michael","David","Robert","William","Richard",
  "Joseph","Thomas","Charles","Christopher","Daniel","Matthew",
  "Anthony","Mark","Donald","Steven","Paul","Andrew","Kenneth",
  "Joshua","Kevin","Brian","George","Timothy","Ronald","Edward",
  "Jason","Jeffrey","Ryan","Jacob","Gary","Nicholas","Eric",
  "Jonathan","Stephen","Larry","Justin","Scott","Brandon",
  "Benjamin","Samuel","Raymond","Gregory","Frank","Alexander",
  "Patrick","Jack","Dennis","Jerry","Tyler","Aaron","Jose",
  "Henry","Adam","Douglas","Nathan","Peter","Zachary","Kyle",
  "Walter","Harold","Jeremy","Ethan","Carl","Keith","Roger",
  "Gerald","Christian","Terry","Sean","Austin","Arthur",
  "Lawrence","Jesse","Dylan","Bryan","Joe","Jordan","Billy",
  "Bruce","Albert","Willie","Gabriel","Logan","Alan","Juan",
  "Wayne","Roy","Ralph","Randy","Eugene","Vincent","Russell",
  "Elijah","Louis","Philip","Bobby","Johnny","Bradley",
  "Jalen","Darius","Malik","Devonte","Jamal","Tyrese","Keion",
  "Derrick","Marcus","Andre","Devin","Marquis","Terrell",
  "DaShawn","DeAndre","Kendall","Rashad","Trevon","Tre",
  "Damon","Antwan","Laquon","Cedric","Deonte","Javon",
  "Rashaad","Marquise","Kentavious","Travion","Quinton",
  "Broderick","Marlon","Deshawn","Latavius","Arian","Taysom",
  "Dontae","Jameis","Desmond","Cre'Von","Bashaud","Kameron",
  "Jacoby","Amari","Dwayne","Demar","Kelvin","Roquan",
  "Alize","Kadeem","Jahvid","Tavon","Montee","Stedman",
  "Sammie","Tiquan","Cody","Blaine","Mason","Hunter",
  "Cooper","Chase","Cole","Carson","Cade","Zach","Bryce",
  "Tanner","Riley","Parker","Peyton","Griffin","Paxton",
];

const LAST_NAMES = [
  "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller",
  "Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez",
  "Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin",
  "Lee","Perez","Thompson","White","Harris","Sanchez","Clark",
  "Ramirez","Lewis","Robinson","Walker","Young","Hall","Allen",
  "Wright","King","Scott","Green","Baker","Adams","Nelson",
  "Carter","Mitchell","Perez","Roberts","Turner","Phillips",
  "Campbell","Parker","Evans","Edwards","Collins","Stewart",
  "Sanchez","Morris","Rogers","Reed","Cook","Morgan","Bell",
  "Murphy","Bailey","Rivera","Cooper","Richardson","Cox",
  "Howard","Ward","Torres","Peterson","Gray","Ramirez","James",
  "Watson","Brooks","Kelly","Sanders","Price","Bennett","Wood",
  "Barnes","Ross","Henderson","Coleman","Jenkins","Perry",
  "Powell","Long","Patterson","Hughes","Flores","Washington",
  "Butler","Simmons","Foster","Gonzales","Bryant","Alexander",
  "Russell","Griffin","Diaz","Hayes","Myers","Ford","Hamilton",
  "Graham","Sullivan","Wallace","Woods","Cole","West","Jordan",
  "Owens","Reynolds","Fisher","Ellis","Harrison","Gibson",
  "McDonald","Cruz","Marshall","Ortiz","Gomez","Murray",
  "Freeman","Wells","Webb","Simpson","Stevens","Tucker",
  "Porter","Hunter","Hicks","Crawford","Henry","Boyd",
  "Mason","Morales","Kennedy","Warren","Dixon","Ramos",
  "Reyes","Burns","Gordon","Shaw","Holmes","Rice","Robertson",
  "Hunt","Black","Daniels","Palmer","Mills","Nichols",
  "Grant","Knight","Ferguson","Rose","Stone","Hawkins",
  "Dunn","Perkins","Hudson","Spencer","Gardner","Stephens",
  "Payne","Pierce","Berry","Matthews","Arnold","Wagner",
  "Willis","Ray","Watkins","Olsen","Carroll","Duncan",
  "Snyder","Hart","Cunningham","Bradley","Lane","Andrews",
  "Ruiz","Harper","Fox","Riley","Armstrong","Carpenter",
];

const SCHOOLS = [
  "Alabama","Ohio State","Georgia","Michigan","LSU","Penn State",
  "Clemson","Notre Dame","Texas","Oregon","Oklahoma","Florida",
  "Florida State","Auburn","Tennessee","USC","Miami (FL)",
  "Stanford","Texas A&M","Wisconsin","Iowa","Nebraska","Arkansas",
  "Missouri","Ole Miss","Mississippi State","Kentucky","Vanderbilt",
  "Indiana","Purdue","Illinois","Northwestern","Minnesota",
  "Iowa State","Kansas State","Oklahoma State","TCU","Baylor",
  "West Virginia","Pittsburgh","Boston College","Syracuse",
  "Virginia Tech","North Carolina","NC State","Wake Forest","Duke",
  "Louisville","Memphis","UCF","Cincinnati","Houston","Tulane",
  "Utah","BYU","Arizona State","Arizona","Colorado","Washington",
  "Washington State","Oregon State","UCLA","California","San Jose State",
  "Boise State","Fresno State","Wyoming","Nevada","UNLV",
  "Air Force","Army","Navy","Appalachian State","Troy",
  "Louisiana","Georgia Southern","Liberty","UAB","South Alabama",
  "Marshall","Ohio","Western Michigan","Ball State","Toledo",
  "Northern Illinois","Central Michigan","Eastern Michigan",
  "Bowling Green","Buffalo","Akron","Kent State",
  "Connecticut","Rutgers","Maryland","Temple","Virginia",
  "North Dakota State","South Dakota State","Montana","Eastern Washington",
  "Sam Houston State","Jacksonville State","Kennesaw State",
];

// ---------------------------------------------------------------------------
// Position-specific measurable ranges
// (ht_low, ht_high, wt_low, wt_high, forty_low, forty_high)
// ---------------------------------------------------------------------------
const POS_MEASURABLES = {
  QB:  [73,78, 210,235, 4.55,4.80],
  HB:  [67,73, 195,225, 4.35,4.60],
  FB:  [71,74, 230,255, 4.55,4.80],
  WR:  [68,76, 175,215, 4.28,4.55],
  TE:  [74,79, 240,265, 4.45,4.75],
  T:   [76,81, 300,335, 4.90,5.35],
  G:   [74,78, 305,330, 5.00,5.35],
  C:   [73,77, 295,320, 5.00,5.30],
  DE:  [74,79, 240,275, 4.55,4.80],
  DT:  [73,78, 285,320, 4.85,5.20],
  OLB: [73,77, 230,255, 4.45,4.70],
  MLB: [72,76, 230,250, 4.45,4.70],
  CB:  [68,74, 175,200, 4.32,4.55],
  FS:  [71,74, 195,215, 4.38,4.60],
  SS:  [71,75, 200,225, 4.40,4.65],
  K:   [70,75, 185,210, 4.70,5.00],
  P:   [72,77, 190,215, 4.65,5.00],
  LS:  [73,76, 235,255, 4.75,5.10],
};

// ---------------------------------------------------------------------------
// POSITION_DEFAULTS (from utils/defaults.py)
// ---------------------------------------------------------------------------
const POSITION_DEFAULTS = {
  QB: {
    overall:68,speed:68,acceleration:72,agility:70,strength:52,awareness:65,
    throwPower:82,throwAccuracy:72,throwAccuracyShort:74,throwAccuracyMid:72,
    throwAccuracyDeep:68,throwOnTheRun:70,throwUnderPressure:68,playAction:65,
    breakSack:65,tackle:28,hitPower:28,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:65,jumping:65,catching:40,catchInTraffic:38,
    spectacularCatch:38,shortRouteRunning:38,mediumRouteRunning:38,
    deepRouteRunning:38,release:38,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:60,spinMove:50,stiffArm:50,trucking:48,
    breakTackle:50,ballCarrierVision:55,changeOfDirection:68,carrying:55,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:78,toughness:72,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  HB: {
    overall:66,speed:86,acceleration:88,agility:84,strength:60,awareness:60,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:38,hitPower:40,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:38,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:58,jumping:72,catching:65,catchInTraffic:60,
    spectacularCatch:55,shortRouteRunning:55,mediumRouteRunning:50,
    deepRouteRunning:48,release:50,runBlock:38,passBlock:38,runBlockPower:35,
    runBlockFinesse:35,passBlockPower:35,passBlockFinesse:35,impactBlocking:35,
    leadBlock:35,jukeMove:82,spinMove:75,stiffArm:70,trucking:72,
    breakTackle:72,ballCarrierVision:72,changeOfDirection:84,carrying:82,
    kickPower:38,kickAccuracy:38,kickReturn:68,stamina:82,toughness:75,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  FB: {
    overall:64,speed:70,acceleration:72,agility:66,strength:72,awareness:62,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:50,hitPower:55,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:45,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:62,jumping:62,catching:60,catchInTraffic:55,
    spectacularCatch:48,shortRouteRunning:50,mediumRouteRunning:45,
    deepRouteRunning:40,release:45,runBlock:72,passBlock:68,runBlockPower:70,
    runBlockFinesse:62,passBlockPower:65,passBlockFinesse:60,impactBlocking:72,
    leadBlock:74,jukeMove:55,spinMove:50,stiffArm:58,trucking:68,
    breakTackle:62,ballCarrierVision:60,changeOfDirection:62,carrying:68,
    kickPower:38,kickAccuracy:38,kickReturn:40,stamina:80,toughness:78,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  WR: {
    overall:67,speed:90,acceleration:92,agility:86,strength:50,awareness:60,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:28,hitPower:28,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:60,jumping:85,catching:82,catchInTraffic:75,
    spectacularCatch:78,shortRouteRunning:72,mediumRouteRunning:70,
    deepRouteRunning:68,release:75,runBlock:38,passBlock:38,runBlockPower:35,
    runBlockFinesse:35,passBlockPower:35,passBlockFinesse:35,impactBlocking:35,
    leadBlock:35,jukeMove:78,spinMove:65,stiffArm:55,trucking:48,
    breakTackle:55,ballCarrierVision:60,changeOfDirection:86,carrying:72,
    kickPower:38,kickAccuracy:38,kickReturn:65,stamina:82,toughness:72,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  TE: {
    overall:65,speed:76,acceleration:78,agility:72,strength:68,awareness:60,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:45,hitPower:48,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:38,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:60,jumping:75,catching:76,catchInTraffic:72,
    spectacularCatch:65,shortRouteRunning:65,mediumRouteRunning:62,
    deepRouteRunning:58,release:62,runBlock:68,passBlock:62,runBlockPower:65,
    runBlockFinesse:58,passBlockPower:60,passBlockFinesse:55,impactBlocking:65,
    leadBlock:60,jukeMove:62,spinMove:52,stiffArm:58,trucking:62,
    breakTackle:60,ballCarrierVision:58,changeOfDirection:70,carrying:68,
    kickPower:38,kickAccuracy:38,kickReturn:42,stamina:80,toughness:76,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  T: {
    overall:65,speed:62,acceleration:64,agility:58,strength:78,awareness:62,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:38,hitPower:38,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:62,jumping:55,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:72,passBlock:72,runBlockPower:72,
    runBlockFinesse:65,passBlockPower:68,passBlockFinesse:70,impactBlocking:72,
    leadBlock:60,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:55,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:80,toughness:78,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  G: {
    overall:64,speed:56,acceleration:58,agility:54,strength:80,awareness:62,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:38,hitPower:38,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:62,jumping:50,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:74,passBlock:70,runBlockPower:74,
    runBlockFinesse:65,passBlockPower:68,passBlockFinesse:66,impactBlocking:74,
    leadBlock:65,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:52,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:80,toughness:78,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  C: {
    overall:63,speed:54,acceleration:56,agility:52,strength:80,awareness:65,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:38,hitPower:38,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:65,jumping:50,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:72,passBlock:70,runBlockPower:72,
    runBlockFinesse:65,passBlockPower:68,passBlockFinesse:66,impactBlocking:72,
    leadBlock:62,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:50,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:80,toughness:78,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  DE: {
    overall:66,speed:80,acceleration:84,agility:76,strength:75,awareness:58,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:72,tackle:70,hitPower:72,blockShedding:72,finesseMoves:70,
    powerMoves:68,pursuit:72,zoneCoverage:38,manCoverage:38,pressCoverage:38,
    playRecognition:60,jumping:65,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:72,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:80,toughness:76,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  DT: {
    overall:65,speed:70,acceleration:72,agility:65,strength:82,awareness:58,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:68,tackle:72,hitPower:74,blockShedding:74,finesseMoves:65,
    powerMoves:72,pursuit:68,zoneCoverage:38,manCoverage:38,pressCoverage:38,
    playRecognition:60,jumping:60,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:62,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:80,toughness:78,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  OLB: {
    overall:65,speed:82,acceleration:84,agility:78,strength:68,awareness:60,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:68,tackle:72,hitPower:72,blockShedding:65,finesseMoves:62,
    powerMoves:60,pursuit:72,zoneCoverage:65,manCoverage:62,pressCoverage:58,
    playRecognition:62,jumping:68,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:75,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:80,toughness:75,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  MLB: {
    overall:65,speed:76,acceleration:78,agility:72,strength:72,awareness:65,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:58,tackle:76,hitPower:74,blockShedding:60,finesseMoves:55,
    powerMoves:58,pursuit:74,zoneCoverage:68,manCoverage:65,pressCoverage:58,
    playRecognition:66,jumping:65,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:70,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:80,toughness:76,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  CB: {
    overall:67,speed:91,acceleration:93,agility:88,strength:50,awareness:60,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:38,tackle:58,hitPower:58,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:68,zoneCoverage:72,manCoverage:74,pressCoverage:68,
    playRecognition:62,jumping:86,catching:55,catchInTraffic:50,
    spectacularCatch:55,shortRouteRunning:38,mediumRouteRunning:38,
    deepRouteRunning:38,release:72,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:72,spinMove:60,stiffArm:50,trucking:45,
    breakTackle:48,ballCarrierVision:55,changeOfDirection:88,carrying:55,
    kickPower:38,kickAccuracy:38,kickReturn:72,stamina:82,toughness:72,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  FS: {
    overall:65,speed:88,acceleration:90,agility:84,strength:52,awareness:64,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:40,tackle:62,hitPower:62,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:70,zoneCoverage:74,manCoverage:68,pressCoverage:60,
    playRecognition:66,jumping:82,catching:58,catchInTraffic:52,
    spectacularCatch:55,shortRouteRunning:38,mediumRouteRunning:38,
    deepRouteRunning:38,release:62,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:68,spinMove:55,stiffArm:48,trucking:45,
    breakTackle:50,ballCarrierVision:58,changeOfDirection:82,carrying:52,
    kickPower:38,kickAccuracy:38,kickReturn:65,stamina:82,toughness:72,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  SS: {
    overall:65,speed:84,acceleration:86,agility:80,strength:62,awareness:62,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:44,tackle:70,hitPower:72,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:72,zoneCoverage:68,manCoverage:65,pressCoverage:58,
    playRecognition:64,jumping:78,catching:55,catchInTraffic:50,
    spectacularCatch:52,shortRouteRunning:38,mediumRouteRunning:38,
    deepRouteRunning:38,release:60,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:65,spinMove:52,stiffArm:52,trucking:55,
    breakTackle:55,ballCarrierVision:58,changeOfDirection:78,carrying:52,
    kickPower:38,kickAccuracy:38,kickReturn:58,stamina:80,toughness:75,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  K: {
    overall:65,speed:50,acceleration:52,agility:50,strength:50,awareness:60,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:28,hitPower:28,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:60,jumping:50,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:48,carrying:28,
    kickPower:82,kickAccuracy:80,kickReturn:38,stamina:78,toughness:70,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  P: {
    overall:65,speed:50,acceleration:52,agility:50,strength:50,awareness:60,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:28,hitPower:28,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:60,jumping:50,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:28,passBlock:28,runBlockPower:28,
    runBlockFinesse:28,passBlockPower:28,passBlockFinesse:28,impactBlocking:28,
    leadBlock:28,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:48,carrying:28,
    kickPower:82,kickAccuracy:80,kickReturn:38,stamina:78,toughness:70,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
  LS: {
    overall:62,speed:52,acceleration:54,agility:50,strength:65,awareness:65,
    throwPower:28,throwAccuracy:28,throwAccuracyShort:28,throwAccuracyMid:28,
    throwAccuracyDeep:28,throwOnTheRun:28,throwUnderPressure:28,playAction:28,
    breakSack:28,tackle:38,hitPower:38,blockShedding:28,finesseMoves:28,
    powerMoves:28,pursuit:28,zoneCoverage:28,manCoverage:28,pressCoverage:28,
    playRecognition:65,jumping:50,catching:28,catchInTraffic:28,
    spectacularCatch:28,shortRouteRunning:28,mediumRouteRunning:28,
    deepRouteRunning:28,release:28,runBlock:55,passBlock:55,runBlockPower:55,
    runBlockFinesse:50,passBlockPower:52,passBlockFinesse:50,impactBlocking:55,
    leadBlock:50,jukeMove:28,spinMove:28,stiffArm:28,trucking:28,
    breakTackle:28,ballCarrierVision:28,changeOfDirection:48,carrying:28,
    kickPower:38,kickAccuracy:38,kickReturn:38,stamina:78,toughness:72,
    injury:78,morale:75,personality:0,devTrait:0,unkRating1:50,
  },
};

// ---------------------------------------------------------------------------
// Rating helpers
// ---------------------------------------------------------------------------
const FIXED_FIELDS = new Set(["personality", "devTrait", "unkRating1"]);

function jitter(val, lo = -8, hi = 8) {
  return Math.max(28, Math.min(99, val + randInt(lo, hi)));
}

function makeRatings(pos, defaults, roundNum) {
  const penalty = (roundNum - 3) * 4;
  const ratings = {};

  for (const [field, base] of Object.entries(defaults)) {
    if (FIXED_FIELDS.has(field)) {
      ratings[field] = base;
      continue;
    }
    if (base <= 35) {
      ratings[field] = randInt(28, 42);
    } else {
      const adj = Math.max(28, base - penalty);
      ratings[field] = jitter(adj, -6, 6);
    }
  }

  ratings.overall = Math.max(58, Math.min(74,
    (defaults.overall || 65) - penalty + randInt(-4, 4)));
  return ratings;
}

function heightStr(totalInches) {
  return `${Math.floor(totalInches / 12)}-${totalInches % 12}`;
}

function inferRound(rank) {
  if (rank <= 32)  return 1;
  if (rank <= 96)  return 2;
  if (rank <= 160) return 3;
  if (rank <= 224) return 4;
  if (rank <= 288) return 5;
  if (rank <= 320) return 6;
  return 7;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`ERROR: ${INPUT_FILE} not found — run script 5 first.`);
    process.exit(1);
  }

  const prospects = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  console.log(`Loaded ${prospects.length} existing prospects from ${path.basename(INPUT_FILE)}`);

  if (prospects.length >= TARGET_TOTAL) {
    console.log(`Already at ${prospects.length} prospects (target ${TARGET_TOTAL}) — nothing to do.`);
    process.exit(0);
  }

  // Count current positions
  const posCounts = {};
  for (const p of prospects) {
    posCounts[p.pos] = (posCounts[p.pos] || 0) + 1;
  }

  // Build used-names set
  const usedNames = new Set(
    prospects.map(p => `${p.firstName.toLowerCase()}${p.lastName.toLowerCase()}`)
  );

  const totalExisting = prospects.length;
  const totalNeeded   = TARGET_TOTAL - totalExisting;

  // Calculate additions per position
  const additions = {};
  for (const [pos, target] of Object.entries(POSITION_TARGETS)) {
    const have  = posCounts[pos] || 0;
    additions[pos] = Math.max(0, target - have);
  }

  // Spread shortfall across fill positions
  let totalPlanned = Object.values(additions).reduce((a, b) => a + b, 0);
  if (totalPlanned < totalNeeded) {
    const fillPositions = ["WR","CB","DE","OLB","T","HB","DT","MLB","FS"];
    let shortfall = totalNeeded - totalPlanned;
    let i = 0;
    while (shortfall > 0) {
      additions[fillPositions[i % fillPositions.length]] += 1;
      shortfall--;
      i++;
    }
  }

  let maxRank = prospects.reduce((mx, p) => Math.max(mx, p.rank || 0), 0);
  const fillerProspects = [];

  for (const [pos, count] of Object.entries(additions)) {
    if (count === 0) continue;

    const defaults  = POSITION_DEFAULTS[pos] || POSITION_DEFAULTS.QB;
    const measRange = POS_MEASURABLES[pos] || [72,76, 220,250, 4.60,4.90];
    const [htLow, htHigh, wtLow, wtHigh, ftLow, ftHigh] = measRange;

    for (let j = 0; j < count; j++) {
      // Generate unique name
      let fn, ln, key;
      let attempts = 0;
      while (true) {
        fn  = randChoice(FIRST_NAMES);
        ln  = randChoice(LAST_NAMES);
        key = fn.toLowerCase() + ln.toLowerCase();
        if (!usedNames.has(key) || attempts > 50) {
          usedNames.add(key);
          break;
        }
        attempts++;
      }

      maxRank++;
      const roundNum  = Math.min(7, Math.max(4, inferRound(maxRank)));
      const htInches  = randInt(htLow, htHigh);
      const wt        = randInt(wtLow, wtHigh);
      const forty     = Math.round(randFloat(ftLow, ftHigh) * 100) / 100;

      const gradeMap = { 4: "C", 5: "C-", 6: "D+", 7: "D" };
      const ratings  = makeRatings(pos, defaults, roundNum);

      fillerProspects.push({
        firstName:  fn,
        lastName:   ln,
        pos,
        school:     randChoice(SCHOOLS),
        ht:         heightStr(htInches),
        wt,
        forty,
        bench:      null,
        vertical:   null,
        broad_jump: null,
        cone:       null,
        shuttle:    null,
        rank:       maxRank,
        grade:      gradeMap[roundNum] || "D",
        notes:      "",
        draftRound: roundNum,
        draftPick:  maxRank,
        ratings,
      });
    }
  }

  const allProspects = prospects.concat(fillerProspects);
  allProspects.sort((a, b) => (a.rank || 9999) - (b.rank || 9999));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allProspects, null, 2), "utf-8");

  // Summary
  const finalCounts = {};
  for (const p of allProspects) {
    finalCounts[p.pos] = (finalCounts[p.pos] || 0) + 1;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Original prospects : ${totalExisting}`);
  console.log(`  Filler added       : ${fillerProspects.length}`);
  console.log(`  Total written      : ${allProspects.length}`);
  console.log(`\n  Position breakdown:`);
  for (const pos of Object.keys(finalCounts).sort()) {
    console.log(`    ${pos.padEnd(6)} ${finalCounts[pos]}`);
  }
  console.log(`\n✓ Written: ${OUTPUT_FILE}`);
  console.log("  Next: node scripts/6_create_draft_class.js");
}

main();
