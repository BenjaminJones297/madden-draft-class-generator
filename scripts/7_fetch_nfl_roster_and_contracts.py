"""
Script 7 — Fetch current NFL roster and contract data.

Downloads:
  - Current NFL rosters from nflverse → data/raw/roster_current.csv
  - Contract data from nflverse (contracts) or Over The Cap (scraping fallback)

Outputs:
  data/nfl_rosters_2026.json  — merged player + contract data, one object per player

Run:
  python scripts/7_fetch_nfl_roster_and_contracts.py
"""

import csv
import io
import json
import os
import re
import sys
import time

import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")

# ---------------------------------------------------------------------------
# Source URLs
# ---------------------------------------------------------------------------
ROSTER_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2025.csv"
)
# nflverse contract data (sourced from Over The Cap)
CONTRACTS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/contracts/historical_contracts.csv.gz"
)
# Over The Cap scraping fallback
OTC_CONTRACTS_URL = "https://overthecap.com/contracts"

# ---------------------------------------------------------------------------
# Position normalisation: raw nflverse position → canonical Madden position
# ---------------------------------------------------------------------------
POSITION_MAP = {
    "QB": "QB",
    "HB": "HB", "RB": "HB",
    "FB": "FB",
    "WR": "WR",
    "TE": "TE",
    "T": "T", "OT": "T", "LT": "T", "RT": "T",
    "G": "G", "OG": "G", "LG": "G", "RG": "G",
    "C": "C", "OL": "G",
    "DE": "DE", "EDGE": "DE",
    "DT": "DT", "NT": "DT",
    "OLB": "OLB",
    "MLB": "MLB", "ILB": "MLB",
    "LB": "OLB",
    "CB": "CB",
    "FS": "FS",
    "SS": "SS",
    "S": "FS", "DB": "CB",
    "K": "K", "PK": "K",
    "P": "P",
    "LS": "LS",
}

# ---------------------------------------------------------------------------
# 2026 NFL Free Agency moves: player_name_lower → {team, contract_years, total_contract_value}
# Only includes players who CHANGED teams (not retained players).
# total_contract_value in dollars (0 if unknown).
# ---------------------------------------------------------------------------
FA_MOVES_2026 = {
    # ARI
    "isaac seumalo":       {"team": "ARI", "contract_years": 3, "total_contract_value": 31_500_000},
    "tyler allgeier":      {"team": "ARI", "contract_years": 2, "total_contract_value": 12_250_000},
    "roy lopez":           {"team": "ARI", "contract_years": 2, "total_contract_value": 11_500_000},
    "kendrick bourne":     {"team": "ARI", "contract_years": 2, "total_contract_value": 10_000_000},
    "gardner minshew":     {"team": "ARI", "contract_years": 1, "total_contract_value":  5_750_000},
    "andrew wingard":      {"team": "ARI", "contract_years": 1, "total_contract_value":  3_000_000},
    "matt pryor":          {"team": "ARI", "contract_years": 1, "total_contract_value":          0},
    # ATL
    "jahan dotson":        {"team": "ATL", "contract_years": 2, "total_contract_value": 15_000_000},
    "jake bailey":         {"team": "ATL", "contract_years": 3, "total_contract_value":  9_000_000},
    "austin hooper":       {"team": "ATL", "contract_years": 1, "total_contract_value":  3_250_000},
    "cameron thomas":      {"team": "ATL", "contract_years": 1, "total_contract_value":  3_100_000},
    "tua tagovailoa":      {"team": "ATL", "contract_years": 1, "total_contract_value":  1_300_000},
    "chris williams":      {"team": "ATL", "contract_years": 1, "total_contract_value":  2_000_000},
    "azeez ojulari":       {"team": "ATL", "contract_years": 1, "total_contract_value":          0},
    "channing tindall":    {"team": "ATL", "contract_years": 1, "total_contract_value":          0},
    "olamide zaccheaus":   {"team": "ATL", "contract_years": 1, "total_contract_value":          0},
    "dashawn hand":        {"team": "ATL", "contract_years": 1, "total_contract_value":  3_000_000},
    "da'shawn hand":       {"team": "ATL", "contract_years": 1, "total_contract_value":  3_000_000},
    # BAL
    "trey hendrickson":    {"team": "BAL", "contract_years": 4, "total_contract_value": 112_000_000},
    "john simpson":        {"team": "BAL", "contract_years": 3, "total_contract_value":  30_000_000},
    "jaylinn hawkins":     {"team": "BAL", "contract_years": 2, "total_contract_value":  10_000_000},
    # BUF
    "dj moore":            {"team": "BUF", "contract_years": 0, "total_contract_value":           0},
    "bradley chubb":       {"team": "BUF", "contract_years": 3, "total_contract_value":  43_500_000},
    "dee alford":          {"team": "BUF", "contract_years": 3, "total_contract_value":  21_000_000},
    "cj gardner-johnson":  {"team": "BUF", "contract_years": 1, "total_contract_value":   6_000_000},
    "c.j. gardner-johnson":{"team": "BUF", "contract_years": 1, "total_contract_value":   6_000_000},
    "kyle allen":          {"team": "BUF", "contract_years": 2, "total_contract_value":   4_100_000},
    "geno stone":          {"team": "BUF", "contract_years": 1, "total_contract_value":           0},
    # CAR
    "jaelan phillips":     {"team": "CAR", "contract_years": 4, "total_contract_value": 120_000_000},
    "devin lloyd":         {"team": "CAR", "contract_years": 3, "total_contract_value":  45_000_000},
    "rasheed walker":      {"team": "CAR", "contract_years": 1, "total_contract_value":           0},
    "kenny pickett":       {"team": "CAR", "contract_years": 1, "total_contract_value":           0},
    "luke fortner":        {"team": "CAR", "contract_years": 1, "total_contract_value":           0},
    "john metchie iii":    {"team": "CAR", "contract_years": 1, "total_contract_value":           0},
    "stone forsythe":      {"team": "CAR", "contract_years": 1, "total_contract_value":           0},
    # CHI
    "coby bryant":         {"team": "CHI", "contract_years": 3, "total_contract_value":  40_000_000},
    "devin bush":          {"team": "CHI", "contract_years": 3, "total_contract_value":  30_000_000},
    "neville gallimore":   {"team": "CHI", "contract_years": 2, "total_contract_value":  12_000_000},
    "kalif raymond":       {"team": "CHI", "contract_years": 1, "total_contract_value":           0},
    "jedrick wills jr.":   {"team": "CHI", "contract_years": 1, "total_contract_value":           0},
    "jedrick wills":       {"team": "CHI", "contract_years": 1, "total_contract_value":           0},
    "garrett bradbury":    {"team": "CHI", "contract_years": 0, "total_contract_value":           0},
    # CIN
    "boye mafe":           {"team": "CIN", "contract_years": 3, "total_contract_value":  60_000_000},
    "bryan cook":          {"team": "CIN", "contract_years": 3, "total_contract_value":  42_500_000},
    "jonathan allen":      {"team": "CIN", "contract_years": 2, "total_contract_value":  28_000_000},
    "josh johnson":        {"team": "CIN", "contract_years": 1, "total_contract_value":           0},
    # CLE
    "zion johnson":        {"team": "CLE", "contract_years": 3, "total_contract_value":  49_500_000},
    "elgton jenkins":      {"team": "CLE", "contract_years": 2, "total_contract_value":  24_000_000},
    "quincy williams":     {"team": "CLE", "contract_years": 2, "total_contract_value":           0},
    "jack stoll":          {"team": "CLE", "contract_years": 1, "total_contract_value":           0},
    "tytus howard":        {"team": "CLE", "contract_years": 0, "total_contract_value":           0},
    # DAL
    "jalen thompson":      {"team": "DAL", "contract_years": 3, "total_contract_value":  33_000_000},
    "cobie durant":        {"team": "DAL", "contract_years": 1, "total_contract_value":           0},
    "pj locke":            {"team": "DAL", "contract_years": 1, "total_contract_value":   5_000_000},
    "p.j. locke":          {"team": "DAL", "contract_years": 1, "total_contract_value":   5_000_000},
    "otito ogbonnia":      {"team": "DAL", "contract_years": 1, "total_contract_value":   3_000_000},
    "sam howell":          {"team": "DAL", "contract_years": 1, "total_contract_value":           0},
    "rashan gary":         {"team": "DAL", "contract_years": 0, "total_contract_value":           0},
    # DET
    "cade mays":           {"team": "DET", "contract_years": 3, "total_contract_value":  25_000_000},
    "rock ya-sin":         {"team": "DET", "contract_years": 1, "total_contract_value":   4_000_000},
    "isiah pacheco":       {"team": "DET", "contract_years": 0, "total_contract_value":           0},
    "tyler conklin":       {"team": "DET", "contract_years": 1, "total_contract_value":           0},
    "teddy bridgewater":   {"team": "DET", "contract_years": 0, "total_contract_value":           0},
    "larry borom":         {"team": "DET", "contract_years": 1, "total_contract_value":   5_000_000},
    "christian izien":     {"team": "DET", "contract_years": 1, "total_contract_value":           0},
    "roger mccreary":      {"team": "DET", "contract_years": 1, "total_contract_value":           0},
    "juice scruggs":       {"team": "DET", "contract_years": 0, "total_contract_value":           0},
    # GB
    "javon hargrave":      {"team": "GB",  "contract_years": 2, "total_contract_value":  23_000_000},
    "benjamin st-juste":   {"team": "GB",  "contract_years": 2, "total_contract_value":  10_000_000},
    "skyy moore":          {"team": "GB",  "contract_years": 1, "total_contract_value":           0},
    "zaire franklin":      {"team": "GB",  "contract_years": 0, "total_contract_value":           0},
    # HOU
    "reed blankenship":    {"team": "HOU", "contract_years": 3, "total_contract_value":  24_750_000},
    "braden smith":        {"team": "HOU", "contract_years": 2, "total_contract_value":  20_000_000},
    "logan hall":          {"team": "HOU", "contract_years": 2, "total_contract_value":   7_000_000},
    "dominique robinson":  {"team": "HOU", "contract_years": 1, "total_contract_value":           0},
    "wyatt teller":        {"team": "HOU", "contract_years": 2, "total_contract_value":  16_000_000},
    "david montgomery":    {"team": "HOU", "contract_years": 0, "total_contract_value":           0},
    "kai kroeger":         {"team": "HOU", "contract_years": 0, "total_contract_value":           0},
    "evan brown":          {"team": "HOU", "contract_years": 1, "total_contract_value":   3_500_000},
    "foster moreau":       {"team": "HOU", "contract_years": 0, "total_contract_value":           0},
    # IND
    "arden key":           {"team": "IND", "contract_years": 2, "total_contract_value":           0},
    "michael clemons":     {"team": "IND", "contract_years": 3, "total_contract_value":  17_500_000},
    "jonathan owens":      {"team": "IND", "contract_years": 1, "total_contract_value":           0},
    "colby wooden":        {"team": "IND", "contract_years": 0, "total_contract_value":           0},
    # JAX
    "chris rodriguez jr.": {"team": "JAX", "contract_years": 2, "total_contract_value":  10_000_000},
    "chris rodriguez":     {"team": "JAX", "contract_years": 2, "total_contract_value":  10_000_000},
    # KC
    "kenneth walker iii":  {"team": "KC",  "contract_years": 3, "total_contract_value":  45_000_000},
    "kenneth walker":      {"team": "KC",  "contract_years": 3, "total_contract_value":  45_000_000},
    "alohi gilman":        {"team": "KC",  "contract_years": 3, "total_contract_value":  24_750_000},
    "khyiris tonga":       {"team": "KC",  "contract_years": 3, "total_contract_value":  21_000_000},
    "emari demercado":     {"team": "KC",  "contract_years": 1, "total_contract_value":           0},
    "kader kohou":         {"team": "KC",  "contract_years": 0, "total_contract_value":           0},
    # LA
    "trent mcduffie":      {"team": "LA",  "contract_years": 4, "total_contract_value": 124_000_000},
    "jaylen watson":       {"team": "LA",  "contract_years": 3, "total_contract_value":  51_000_000},
    # LAC
    "tyler biadasz":       {"team": "LAC", "contract_years": 3, "total_contract_value":  30_000_000},
    "charlie kolar":       {"team": "LAC", "contract_years": 3, "total_contract_value":  24_300_000},
    "keaton mitchell":     {"team": "LAC", "contract_years": 2, "total_contract_value":   9_250_000},
    "cole strange":        {"team": "LAC", "contract_years": 2, "total_contract_value":  13_000_000},
    "alec ingold":         {"team": "LAC", "contract_years": 2, "total_contract_value":   7_500_000},
    "dalvin tomlinson":    {"team": "LAC", "contract_years": 1, "total_contract_value":   7_500_000},
    # LV
    "taron johnson":       {"team": "LV",  "contract_years": 0, "total_contract_value":           0},
    "tyler linderbaum":    {"team": "LV",  "contract_years": 3, "total_contract_value":  81_000_000},
    "kwity paye":          {"team": "LV",  "contract_years": 3, "total_contract_value":  48_000_000},
    "quay walker":         {"team": "LV",  "contract_years": 3, "total_contract_value":  40_500_000},
    "nakobe dean":         {"team": "LV",  "contract_years": 3, "total_contract_value":  36_000_000},
    "jalen nailor":        {"team": "LV",  "contract_years": 3, "total_contract_value":  35_000_000},
    "connor heyward":      {"team": "LV",  "contract_years": 2, "total_contract_value":   5_500_000},
    "matt gay":            {"team": "LV",  "contract_years": 1, "total_contract_value":           0},
    "dareke young":        {"team": "LV",  "contract_years": 0, "total_contract_value":           0},
    # MIA
    "malik willis":        {"team": "MIA", "contract_years": 3, "total_contract_value":  67_500_000},
    "joshua uche":         {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    "david ojabo":         {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    "jalen tolbert":       {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    "jamaree salyer":      {"team": "MIA", "contract_years": 0, "total_contract_value":           0},
    "zayne anderson":      {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    "lonnie johnson jr.":  {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    "lonnie johnson":      {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    "robert beal jr.":     {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    "robert beal":         {"team": "MIA", "contract_years": 1, "total_contract_value":           0},
    # MIN
    "kyler murray":        {"team": "MIN", "contract_years": 1, "total_contract_value":           0},
    "james pierre":        {"team": "MIN", "contract_years": 2, "total_contract_value":   8_500_000},
    # NE
    "romeo doubs":         {"team": "NE",  "contract_years": 4, "total_contract_value":  68_000_000},
    "alijah vera-tucker":  {"team": "NE",  "contract_years": 3, "total_contract_value":  42_000_000},
    "dremont jones":       {"team": "NE",  "contract_years": 3, "total_contract_value":  39_500_000},
    "dre'mont jones":      {"team": "NE",  "contract_years": 3, "total_contract_value":  39_500_000},
    "reggie gilliam":      {"team": "NE",  "contract_years": 3, "total_contract_value":           0},
    "kevin byard":         {"team": "NE",  "contract_years": 1, "total_contract_value":   9_000_000},
    "jesse luketa":        {"team": "NE",  "contract_years": 1, "total_contract_value":           0},
    "kj britt":            {"team": "NE",  "contract_years": 1, "total_contract_value":           0},
    "k.j. britt":          {"team": "NE",  "contract_years": 1, "total_contract_value":           0},
    # NO
    "david edwards":       {"team": "NO",  "contract_years": 4, "total_contract_value":  61_000_000},
    "travis etienne":      {"team": "NO",  "contract_years": 4, "total_contract_value":  52_000_000},
    "travis etienne jr.":  {"team": "NO",  "contract_years": 4, "total_contract_value":  52_000_000},
    "kaden elliss":        {"team": "NO",  "contract_years": 3, "total_contract_value":  33_000_000},
    "ryan wright":         {"team": "NO",  "contract_years": 4, "total_contract_value":  14_000_000},
    "noah fant":           {"team": "NO",  "contract_years": 2, "total_contract_value":   8_750_000},
    "ty chandler":         {"team": "NO",  "contract_years": 0, "total_contract_value":           0},
    # NYG
    "isaiah likely":       {"team": "NYG", "contract_years": 3, "total_contract_value":  40_000_000},
    "tremaine edmunds":    {"team": "NYG", "contract_years": 3, "total_contract_value":  36_000_000},
    "jordan stout":        {"team": "NYG", "contract_years": 3, "total_contract_value":  12_300_000},
    "greg newsome":        {"team": "NYG", "contract_years": 1, "total_contract_value":   8_000_000},
    "greg newsome ii":     {"team": "NYG", "contract_years": 1, "total_contract_value":   8_000_000},
    "patrick ricard":      {"team": "NYG", "contract_years": 2, "total_contract_value":           0},
    "ardarius washington": {"team": "NYG", "contract_years": 1, "total_contract_value":   3_000_000},
    "ar'darius washington":{"team": "NYG", "contract_years": 1, "total_contract_value":   3_000_000},
    "calvin austin iii":   {"team": "NYG", "contract_years": 1, "total_contract_value":           0},
    "calvin austin":       {"team": "NYG", "contract_years": 1, "total_contract_value":           0},
    "darnell mooney":      {"team": "NYG", "contract_years": 1, "total_contract_value":           0},
    "jason sanders":       {"team": "NYG", "contract_years": 1, "total_contract_value":           0},
    # NYJ
    "joseph ossai":        {"team": "NYJ", "contract_years": 3, "total_contract_value":  36_000_000},
    "demario davis":       {"team": "NYJ", "contract_years": 2, "total_contract_value":  22_000_000},
    "dylan parham":        {"team": "NYJ", "contract_years": 2, "total_contract_value":  16_000_000},
    "david onyemata":      {"team": "NYJ", "contract_years": 1, "total_contract_value":  10_500_000},
    "kingsley enagbare":   {"team": "NYJ", "contract_years": 1, "total_contract_value":  10_000_000},
    "dane belton":         {"team": "NYJ", "contract_years": 1, "total_contract_value":           0},
    "nahshon wright":      {"team": "NYJ", "contract_years": 1, "total_contract_value":   3_500_000},
    "andrew beck":         {"team": "NYJ", "contract_years": 1, "total_contract_value":           0},
    "cade york":           {"team": "NYJ", "contract_years": 1, "total_contract_value":           0},
    "geno smith":          {"team": "NYJ", "contract_years": 0, "total_contract_value":           0},
    "minkah fitzpatrick":  {"team": "NYJ", "contract_years": 3, "total_contract_value":  40_000_000},
    # PHI
    "tariq woolen":        {"team": "PHI", "contract_years": 1, "total_contract_value":  15_000_000},
    "riq woolen":          {"team": "PHI", "contract_years": 1, "total_contract_value":  15_000_000},
    "arnold ebiketie":     {"team": "PHI", "contract_years": 1, "total_contract_value":           0},
    "jonathan jones":      {"team": "PHI", "contract_years": 1, "total_contract_value":           0},
    "hollywood brown":     {"team": "PHI", "contract_years": 1, "total_contract_value":           0},
    # PIT
    "michael pittman jr.": {"team": "PIT", "contract_years": 3, "total_contract_value":  59_000_000},
    "michael pittman":     {"team": "PIT", "contract_years": 3, "total_contract_value":  59_000_000},
    "jamel dean":          {"team": "PIT", "contract_years": 3, "total_contract_value":  36_500_000},
    "rico dowdle":         {"team": "PIT", "contract_years": 2, "total_contract_value":  12_250_000},
    "jaquan brisker":      {"team": "PIT", "contract_years": 1, "total_contract_value":   5_500_000},
    "darnell savage":      {"team": "PIT", "contract_years": 1, "total_contract_value":           0},
    # SF
    "mike evans":          {"team": "SF",  "contract_years": 3, "total_contract_value":  60_400_000},
    "vederian lowe":       {"team": "SF",  "contract_years": 2, "total_contract_value":           0},
    "nate hobbs":          {"team": "SF",  "contract_years": 1, "total_contract_value":   4_000_000},
    "osa odighizuwa":      {"team": "SF",  "contract_years": 0, "total_contract_value":           0},
    # TEN
    "wandale robinson":    {"team": "TEN", "contract_years": 4, "total_contract_value":  70_000_000},
    "wan'dale robinson":   {"team": "TEN", "contract_years": 4, "total_contract_value":  70_000_000},
    "john franklin-myers": {"team": "TEN", "contract_years": 3, "total_contract_value":  63_000_000},
    "alontae taylor":      {"team": "TEN", "contract_years": 3, "total_contract_value":  60_000_000},
    "cordale flott":       {"team": "TEN", "contract_years": 3, "total_contract_value":  45_000_000},
    "cor'dale flott":      {"team": "TEN", "contract_years": 3, "total_contract_value":  45_000_000},
    "daniel bellinger":    {"team": "TEN", "contract_years": 3, "total_contract_value":  24_000_000},
    "jacob martin":        {"team": "TEN", "contract_years": 2, "total_contract_value":  11_000_000},
    "austin schlottmann":  {"team": "TEN", "contract_years": 2, "total_contract_value":   9_000_000},
    "jordan elliott":      {"team": "TEN", "contract_years": 2, "total_contract_value":   8_000_000},
    "tommy townsend":      {"team": "TEN", "contract_years": 2, "total_contract_value":           0},
    "cordell volson":      {"team": "TEN", "contract_years": 1, "total_contract_value":           0},
    "mitchell trubisky":   {"team": "TEN", "contract_years": 2, "total_contract_value":           0},
    "josh williams":       {"team": "TEN", "contract_years": 2, "total_contract_value":           0},
    "malik herring":       {"team": "TEN", "contract_years": 1, "total_contract_value":           0},
    "solomon thomas":      {"team": "TEN", "contract_years": 0, "total_contract_value":           0},
    # WAS
    "odafe oweh":          {"team": "WAS", "contract_years": 4, "total_contract_value": 100_000_000},
    "leo chenal":          {"team": "WAS", "contract_years": 3, "total_contract_value":  24_750_000},
    "tim settle":          {"team": "WAS", "contract_years": 3, "total_contract_value":  24_000_000},
    "chigoziem okonkwo":   {"team": "WAS", "contract_years": 3, "total_contract_value":           0},
    "amik robertson":      {"team": "WAS", "contract_years": 2, "total_contract_value":  16_000_000},
    "nick cross":          {"team": "WAS", "contract_years": 2, "total_contract_value":           0},
    "klavon chaisson":     {"team": "WAS", "contract_years": 1, "total_contract_value":  12_000_000},
    "k'lavon chaisson":    {"team": "WAS", "contract_years": 1, "total_contract_value":  12_000_000},
    "charles omenihu":     {"team": "WAS", "contract_years": 1, "total_contract_value":           0},
    "jerome ford":         {"team": "WAS", "contract_years": 1, "total_contract_value":           0},
    "van jefferson":       {"team": "WAS", "contract_years": 1, "total_contract_value":           0},
}


def _norm_name(name: str) -> str:
    """Normalize player name for FA lookup."""
    return re.sub(r"[^a-z0-9 ]", "", name.lower().strip())


# ---------------------------------------------------------------------------
# Scraping headers (browser-like, to avoid 403s)
# ---------------------------------------------------------------------------
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

REQUEST_TIMEOUT = 30  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def download_csv(url: str, label: str, headers: dict | None = None) -> list[dict] | None:
    """
    Download a CSV (plain or .gz) from *url* and return its rows as a list of dicts.
    Returns None on any error (allows callers to fall back gracefully).
    """
    import gzip

    print(f"\n→ Downloading {label} …")
    print(f"  {url}")

    try:
        resp = requests.get(url, stream=True, timeout=REQUEST_TIMEOUT,
                            headers=headers or {})
        resp.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        print(f"  ⚠  HTTP {exc.response.status_code}: {exc}", file=sys.stderr)
        return None
    except requests.exceptions.RequestException as exc:
        print(f"  ⚠  Request failed: {exc}", file=sys.stderr)
        return None

    total = int(resp.headers.get("content-length", 0)) or None
    chunks = []
    with tqdm(
        total=total,
        unit="B",
        unit_scale=True,
        unit_divisor=1024,
        desc=f"  {label}",
        leave=False,
    ) as bar:
        for chunk in resp.iter_content(chunk_size=65536):
            chunks.append(chunk)
            bar.update(len(chunk))

    raw_bytes = b"".join(chunks)
    # Decompress gzip if needed
    if url.endswith(".gz"):
        raw_bytes = gzip.decompress(raw_bytes)

    text = raw_bytes.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    print(f"  ✓ {len(rows):,} rows")
    return rows


def parse_money(raw: str) -> float:
    """
    Parse a money string like '$12,500,000' or '12.5M' → float (dollars).
    Returns 0.0 if parsing fails.
    """
    if not raw:
        return 0.0
    s = str(raw).strip().replace("$", "").replace(",", "").upper()
    try:
        if "M" in s:
            return float(s.replace("M", "")) * 1_000_000
        if "K" in s:
            return float(s.replace("K", "")) * 1_000
        return float(s)
    except ValueError:
        return 0.0


def scrape_otc_contracts() -> dict[str, dict]:
    """
    Scrape Over The Cap contracts page as a last-resort fallback.
    Returns a dict keyed by lowercase player name.
    """
    print(f"\n→ Scraping Over The Cap contracts page (fallback) …")
    print(f"  {OTC_CONTRACTS_URL}")

    contracts: dict[str, dict] = {}

    try:
        resp = requests.get(
            OTC_CONTRACTS_URL, headers=HEADERS, timeout=REQUEST_TIMEOUT
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException as exc:
        print(f"  ⚠  OTC scraping failed: {exc}", file=sys.stderr)
        return contracts

    soup = BeautifulSoup(resp.text, "lxml")

    # OTC renders a <table id="contracts"> or similar; try several selectors
    table = (
        soup.find("table", {"id": "contracts"})
        or soup.find("table", {"class": re.compile(r"contract", re.I)})
        or soup.find("table")
    )
    if not table:
        print("  ⚠  No contracts table found in OTC HTML", file=sys.stderr)
        return contracts

    tbody = table.find("tbody") or table
    rows = tbody.find_all("tr")

    for row in rows:
        cells = row.find_all(["td", "th"])
        if len(cells) < 5:
            continue

        # Best-guess column order: Player | Team | Pos | Years | Total | APY | GTD | ...
        player_name = cells[0].get_text(strip=True)
        if not player_name or player_name.lower() in ("player", "name"):
            continue  # header row

        team_text   = cells[1].get_text(strip=True) if len(cells) > 1 else ""
        pos_text    = cells[2].get_text(strip=True) if len(cells) > 2 else ""
        years_text  = cells[3].get_text(strip=True) if len(cells) > 3 else ""
        total_text  = cells[4].get_text(strip=True) if len(cells) > 4 else ""
        apy_text    = cells[5].get_text(strip=True) if len(cells) > 5 else ""
        gtd_text    = cells[6].get_text(strip=True) if len(cells) > 6 else ""

        total = parse_money(total_text)
        apy   = parse_money(apy_text)
        gtd   = parse_money(gtd_text)

        try:
            years = int(re.sub(r"[^\d]", "", years_text)) if years_text else 0
        except ValueError:
            years = 0

        if apy > 0 or total > 0:
            contracts[player_name.lower()] = {
                "aav": apy or (total / max(years, 1)),
                "total_value": total,
                "guaranteed": gtd,
                "contract_years": years,
                "team": team_text,
                "position": pos_text,
            }

    print(f"  ✓ {len(contracts):,} player contracts scraped from OTC")
    return contracts


def build_contracts_from_nflverse(rows: list[dict]) -> dict[str, dict]:
    """
    Build a lookup dict from nflverse contracts CSV rows.
    Returns a dict keyed by lowercase player_name.

    Expected nflverse contracts columns (may vary by version):
      player, team, pos, year_signed, years, value, apy, gtd, apy_cap_pct, ...
    For the historical file, keeps the most recent contract per player.
    """
    # Collect all rows per player, then keep the most recent year_signed
    from collections import defaultdict
    by_player: dict[str, list] = defaultdict(list)

    for row in rows:
        name = (
            row.get("player")
            or row.get("player_name")
            or row.get("name")
            or ""
        ).strip()
        if not name:
            continue
        by_player[name.lower()].append(row)

    contracts: dict[str, dict] = {}

    for name_lower, player_rows in by_player.items():
        # Sort by year_signed descending → pick most recent
        def _year(r):
            try:
                return int(float(r.get("year_signed") or r.get("year") or 0))
            except (ValueError, TypeError):
                return 0
        row = sorted(player_rows, key=_year, reverse=True)[0]

        apy   = parse_money(row.get("apy")   or row.get("aav")   or "0")
        total = parse_money(row.get("value")  or row.get("total") or "0")
        gtd   = parse_money(row.get("gtd")    or row.get("guaranteed") or "0")

        try:
            years = int(float(row.get("years") or row.get("length") or 0))
        except (ValueError, TypeError):
            years = 0

        if apy > 0 or total > 0:
            contracts[name_lower] = {
                "aav": apy or (total / max(years, 1)),
                "total_value": total,
                "guaranteed": gtd,
                "contract_years": years,
                "year_signed": _year(row),
                "team": row.get("team", ""),
                "position": row.get("pos", row.get("position", "")),
            }

    return contracts


def normalize_height(raw_ht: str) -> str:
    """
    Normalise height strings to '6-2' format.
    Accepts '6-2', '6\'2"', '74', etc.
    """
    if not raw_ht:
        return ""
    s = str(raw_ht).strip()
    # Already in '6-2' format
    if re.match(r"^\d-\d{1,2}$", s):
        return s
    # Feet/inches: 6'2" or 6'2
    m = re.match(r"^(\d)[\'\"](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    # Total inches: e.g. '74'
    m = re.match(r"^(\d{2,3})$", s)
    if m:
        inches = int(m.group(1))
        feet = inches // 12
        rem  = inches % 12
        return f"{feet}-{rem}"
    return s


def safe_int(val: str | None, default: int = 0) -> int:
    """Parse an integer, returning *default* on failure."""
    try:
        return int(float(str(val).strip()))
    except (ValueError, TypeError, AttributeError):
        return default


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("Script 7 — Fetch NFL roster & contract data")
    print("=" * 60)

    os.makedirs(RAW_DIR, exist_ok=True)

    # ------------------------------------------------------------------
    # 1. Download current NFL rosters from nflverse
    # ------------------------------------------------------------------
    roster_rows = download_csv(ROSTER_URL, "roster_weekly_2025.csv")
    if not roster_rows:
        print("\n✗ Could not download roster data. Exiting.", file=sys.stderr)
        sys.exit(1)

    # Weekly file contains every week — keep the most recent entry per player+team
    # (don't filter to the global max week, which would only show Super Bowl teams)
    if any(r.get("week") for r in roster_rows):
        from collections import defaultdict
        latest: dict[tuple, dict] = {}
        for r in roster_rows:
            try:
                wk = int(float(r.get("week") or 0))
            except (ValueError, TypeError):
                wk = 0
            key = (
                (r.get("player_name") or r.get("full_name") or "").strip().lower(),
                (r.get("team") or r.get("team_abbr") or "").strip().lower(),
            )
            if key not in latest or wk > latest[key][1]:
                latest[key] = (r, wk)
        roster_rows = [v[0] for v in latest.values()]
        print(f"  Deduplicated to most recent week per player: {len(roster_rows):,} rows")

    # Save raw roster CSV
    raw_roster_path = os.path.join(RAW_DIR, "roster_current.csv")
    with open(raw_roster_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(roster_rows[0].keys()))
        writer.writeheader()
        writer.writerows(roster_rows)
    print(f"  Saved → {os.path.relpath(raw_roster_path, PROJECT_ROOT)}")

    # ------------------------------------------------------------------
    # 2. Download / scrape contract data
    # ------------------------------------------------------------------
    contracts: dict[str, dict] = {}

    # Try nflverse contracts CSV first (most reliable)
    contract_rows = download_csv(CONTRACTS_URL, "contracts_current.csv")
    if contract_rows:
        raw_contracts_path = os.path.join(RAW_DIR, "contracts_current.csv")
        with open(raw_contracts_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(contract_rows[0].keys()))
            writer.writeheader()
            writer.writerows(contract_rows)
        print(f"  Saved → {os.path.relpath(raw_contracts_path, PROJECT_ROOT)}")
        contracts = build_contracts_from_nflverse(contract_rows)
        print(f"  ✓ Loaded {len(contracts):,} contracts from nflverse")
    else:
        print("  nflverse contracts not available — trying Over The Cap scraping …")
        time.sleep(1)  # polite delay before scraping
        contracts = scrape_otc_contracts()

    if not contracts:
        print("  ⚠  No contract data found — proceeding with empty contracts")
        print("  Ratings will be estimated from position defaults only.")

    # ------------------------------------------------------------------
    # 3. Merge roster + contract data
    # ------------------------------------------------------------------
    print("\n→ Merging roster and contract data …")

    players: list[dict] = []
    seen: set[tuple] = set()

    for row in roster_rows:
        # Prefer first_name + last_name when both exist (avoids nflverse player_name mismatches)
        first = (row.get("first_name") or "").strip()
        last  = (row.get("last_name")  or "").strip()
        player_name = (
            f"{first} {last}".strip()
            if first and last
            else (row.get("player_name") or row.get("full_name") or "").strip()
        )
        if not player_name:
            continue

        # Status filter: keep active (ACT), practice squad (DEV), injured reserve (RES/INA)
        # Drop cut (CUT), retired (RET), traded-away (TRD/TRC), unknown
        status = (row.get("status") or "").strip().upper()
        if status in ("", "CUT", "RET", "UNK", "EXE", "TRD", "TRC"):
            continue

        # De-duplicate: same player on same team in same season
        team   = (row.get("team") or row.get("team_abbr") or "").strip()
        season = (row.get("season") or "").strip()
        key    = (player_name.lower(), team.lower(), season)
        if key in seen:
            continue
        seen.add(key)

        # Normalise position: prefer depth_chart_position for specific Madden positions
        # (nflverse 'position' uses broad groups like DL/OL/LB/DB)
        dcp = (row.get("depth_chart_position") or "").strip().upper()
        broad = (row.get("position") or "").strip().upper()
        raw_pos = dcp if dcp else broad
        pos = POSITION_MAP.get(raw_pos, POSITION_MAP.get(broad, raw_pos)) if raw_pos else "QB"

        # Contract lookup — try exact name, then last+first swap
        contract = contracts.get(player_name.lower(), {})
        if not contract:
            # Try "Last, First" format that OTC sometimes uses
            parts = player_name.split()
            if len(parts) >= 2:
                alt = f"{parts[-1]}, {' '.join(parts[:-1])}"
                contract = contracts.get(alt.lower(), {})

        # Parse physical attributes
        height = normalize_height(row.get("height") or row.get("ht") or "")
        weight_raw = row.get("weight") or row.get("wt") or ""
        weight = safe_int(weight_raw) if weight_raw else None

        player = {
            "player_name":        player_name,
            "first_name":         (row.get("first_name") or "").strip(),
            "last_name":          (row.get("last_name")  or "").strip(),
            "team":               team,
            "position":           pos,
            "depth_chart_position": (row.get("depth_chart_position") or raw_pos).strip(),
            "jersey_number":      safe_int(row.get("jersey_number") or row.get("number")),
            "status":             status,
            "birth_date":         (row.get("birth_date") or row.get("dob") or "").strip(),
            "height":             height,
            "weight":             weight,
            "college":            (row.get("college") or row.get("college_name") or "").strip(),
            "experience":         safe_int(row.get("years_exp") or row.get("experience")),
            "season":             season,
            # Contract fields
            "aav":                contract.get("aav", 0.0),
            "total_contract_value": contract.get("total_value", 0.0),
            "guaranteed":         contract.get("guaranteed", 0.0),
            "contract_years":     contract.get("contract_years", 0),
        }

        players.append(player)

    print(f"  ✓ Merged {len(players):,} players")

    # ------------------------------------------------------------------
    # 3b. Apply 2026 FA team changes
    # ------------------------------------------------------------------
    fa_norm = {_norm_name(k): v for k, v in FA_MOVES_2026.items()}
    fa_applied = 0
    for player in players:
        norm = _norm_name(player["player_name"])
        if norm in fa_norm:
            move = fa_norm[norm]
            player["team"] = move["team"]
            if move.get("contract_years"):
                player["contract_years"] = move["contract_years"]
            if move.get("total_contract_value"):
                player["total_contract_value"] = move["total_contract_value"]
            fa_applied += 1

    print(f"  ✓ Applied 2026 FA team changes to {fa_applied} players")

    # ------------------------------------------------------------------
    # 4. Save output
    # ------------------------------------------------------------------
    out_path = os.path.join(DATA_DIR, "nfl_rosters_2026.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(players, fh, indent=2)

    print(f"\n  Saved → {os.path.relpath(out_path, PROJECT_ROOT)}")

    # ------------------------------------------------------------------
    # 5. Summary
    # ------------------------------------------------------------------
    from collections import Counter
    pos_counts = Counter(p["position"] for p in players)
    teams_with_contracts = sum(1 for p in players if p["aav"] > 0)

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"  Total players : {len(players):,}")
    print(f"  With contracts: {teams_with_contracts:,}")
    print(f"  Positions     : {dict(sorted(pos_counts.items()))}")
    print("\n✓ Done.")


if __name__ == "__main__":
    main()
