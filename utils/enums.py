"""
Shared enum mappings for Madden 26 draft class generation.
"""

# DraftPositionE enum values from M26 schema
POSITION_TO_ENUM = {
    "QB":  0,
    "HB":  1,
    "RB":  1,  # alias
    "FB":  2,
    "WR":  3,
    "TE":  4,
    "T":   5,
    "OT":  5,  # alias
    "LT":  5,  # alias
    "RT":  5,  # alias
    "G":   6,
    "OG":  6,  # alias
    "LG":  6,  # alias
    "RG":  6,  # alias
    "C":   7,
    "DE":  8,
    "DT":  9,
    "NT":  9,  # alias
    "OLB": 10,
    "EDGE": 8, # map EDGE to DE
    "ILB": 11, # alias
    "MLB": 11,
    "LB":  10, # default LB to OLB
    "CB":  12,
    "FS":  13,
    "SS":  14,
    "S":   13, # default S to FS
    "DB":  12, # default DB to CB
    "K":   15,
    "PK":  15, # alias
    "P":   16,
    "LS":  17,
}

# Dev trait values
DEV_TRAIT = {
    "Normal":  0,
    "Impact":  1,
    "Star":    2,
    "XFactor": 3,
}

# US state abbreviation → byte value (alphabetical index, 1-based, 0=unknown)
STATE_TO_ENUM = {
    "":   0,
    "AL": 1,  "AK": 2,  "AZ": 3,  "AR": 4,  "CA": 5,
    "CO": 6,  "CT": 7,  "DE": 8,  "FL": 9,  "GA": 10,
    "HI": 11, "ID": 12, "IL": 13, "IN": 14, "IA": 15,
    "KS": 16, "KY": 17, "LA": 18, "ME": 19, "MD": 20,
    "MA": 21, "MI": 22, "MN": 23, "MS": 24, "MO": 25,
    "MT": 26, "NE": 27, "NV": 28, "NH": 29, "NJ": 30,
    "NM": 31, "NY": 32, "NC": 33, "ND": 34, "OH": 35,
    "OK": 36, "OR": 37, "PA": 38, "RI": 39, "SC": 40,
    "SD": 41, "TN": 42, "TX": 43, "UT": 44, "VT": 45,
    "VA": 46, "WA": 47, "WV": 48, "WI": 49, "WY": 50,
    "DC": 51,
}

# All rating fields required in the prospects_rated.json output
ALL_RATING_FIELDS = [
    "overall", "speed", "acceleration", "agility", "strength", "awareness",
    "throwPower", "throwAccuracy", "throwAccuracyShort", "throwAccuracyMid",
    "throwAccuracyDeep", "throwOnTheRun", "throwUnderPressure", "playAction",
    "breakSack", "tackle", "hitPower", "blockShedding", "finesseMoves",
    "powerMoves", "pursuit", "zoneCoverage", "manCoverage", "pressCoverage",
    "playRecognition", "jumping", "catching", "catchInTraffic", "spectacularCatch",
    "shortRouteRunning", "mediumRouteRunning", "deepRouteRunning", "release",
    "runBlock", "passBlock", "runBlockPower", "runBlockFinesse", "passBlockPower",
    "passBlockFinesse", "impactBlocking", "leadBlock", "jukeMove", "spinMove",
    "stiffArm", "trucking", "breakTackle", "ballCarrierVision", "changeOfDirection",
    "carrying", "kickPower", "kickAccuracy", "kickReturn", "stamina", "toughness",
    "injury", "morale", "personality", "devTrait", "unkRating1",
]

# The subset of fields the LLM should focus on per position group
# (rest will be filled with position defaults)
POSITION_KEY_FIELDS = {
    "QB":  ["overall", "speed", "acceleration", "awareness", "throwPower",
            "throwAccuracy", "throwAccuracyShort", "throwAccuracyMid", "throwAccuracyDeep",
            "throwOnTheRun", "throwUnderPressure", "playAction", "breakSack",
            "agility", "strength", "devTrait"],
    "HB":  ["overall", "speed", "acceleration", "agility", "strength", "awareness",
            "carrying", "ballCarrierVision", "breakTackle", "trucking", "stiffArm",
            "spinMove", "jukeMove", "changeOfDirection", "catching", "devTrait"],
    "FB":  ["overall", "speed", "strength", "awareness", "carrying", "impactBlocking",
            "leadBlock", "runBlock", "passBlock", "catching", "devTrait"],
    "WR":  ["overall", "speed", "acceleration", "agility", "awareness", "catching",
            "catchInTraffic", "spectacularCatch", "shortRouteRunning", "mediumRouteRunning",
            "deepRouteRunning", "release", "jumping", "strength", "devTrait"],
    "TE":  ["overall", "speed", "acceleration", "strength", "awareness", "catching",
            "catchInTraffic", "runBlock", "passBlock", "impactBlocking", "devTrait"],
    "T":   ["overall", "speed", "strength", "awareness", "passBlock", "passBlockPower",
            "passBlockFinesse", "runBlock", "runBlockPower", "runBlockFinesse",
            "impactBlocking", "agility", "devTrait"],
    "G":   ["overall", "strength", "awareness", "passBlock", "passBlockPower",
            "passBlockFinesse", "runBlock", "runBlockPower", "runBlockFinesse",
            "impactBlocking", "devTrait"],
    "C":   ["overall", "strength", "awareness", "passBlock", "passBlockPower",
            "passBlockFinesse", "runBlock", "runBlockPower", "runBlockFinesse",
            "impactBlocking", "devTrait"],
    "DE":  ["overall", "speed", "acceleration", "strength", "awareness", "blockShedding",
            "finesseMoves", "powerMoves", "tackle", "hitPower", "pursuit", "devTrait"],
    "DT":  ["overall", "speed", "strength", "awareness", "blockShedding",
            "finesseMoves", "powerMoves", "tackle", "hitPower", "pursuit", "devTrait"],
    "OLB": ["overall", "speed", "acceleration", "strength", "awareness", "blockShedding",
            "tackle", "hitPower", "pursuit", "zoneCoverage", "manCoverage",
            "playRecognition", "devTrait"],
    "MLB": ["overall", "speed", "strength", "awareness", "tackle", "hitPower",
            "pursuit", "zoneCoverage", "manCoverage", "playRecognition", "devTrait"],
    "CB":  ["overall", "speed", "acceleration", "agility", "awareness", "manCoverage",
            "zoneCoverage", "pressCoverage", "playRecognition", "jumping", "tackle",
            "hitPower", "release", "devTrait"],
    "FS":  ["overall", "speed", "acceleration", "agility", "awareness", "zoneCoverage",
            "manCoverage", "playRecognition", "tackle", "hitPower", "jumping", "devTrait"],
    "SS":  ["overall", "speed", "strength", "awareness", "tackle", "hitPower",
            "zoneCoverage", "manCoverage", "playRecognition", "pursuit", "devTrait"],
    "K":   ["overall", "kickPower", "kickAccuracy", "devTrait"],
    "P":   ["overall", "kickPower", "kickAccuracy", "devTrait"],
    "LS":  ["overall", "strength", "awareness", "devTrait"],
}
