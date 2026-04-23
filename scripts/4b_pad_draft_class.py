"""
Script 4b — Pad draft class to TARGET_TOTAL prospects.

Reads data/prospects_rated.json (output of script 5), adds filler prospects
with realistic names, measurables, and position-appropriate Madden ratings
to reach at least TARGET_TOTAL prospects, then writes the padded file back.

Filler prospects:
  - Realistic first/last names drawn from large pools
  - Position-appropriate heights, weights, and 40-yard dashes
  - Ratings derived from POSITION_DEFAULTS with random variance
  - Overall ratings in the 60-72 range (rounds 4-7 depth)
  - Never duplicates names already in the file

Usage:
    python scripts/4b_pad_draft_class.py [--target 300] [--seed 42]
"""

import argparse
import copy
import json
import os
import random
import sys

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_ROOT)

DATA_DIR     = os.path.join(PROJECT_ROOT, "data")
INPUT_FILE   = os.path.join(DATA_DIR, "prospects_rated.json")
OUTPUT_FILE  = INPUT_FILE  # overwrite in place

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TARGET_TOTAL = 300

# Target roster distribution for a ~300-prospect class
POSITION_TARGETS = {
    "QB":  15, "HB":  20, "FB":   5, "WR":  40, "TE":  15,
    "T":   25, "G":   15, "C":   10,
    "DE":  30, "DT":  20, "OLB": 20, "MLB": 15,
    "CB":  35, "FS":  15, "SS":  15,
    "K":    5, "P":    5, "LS":   5,
}

# ---------------------------------------------------------------------------
# Name pools  (first names by vibe, last names diverse)
# ---------------------------------------------------------------------------
FIRST_NAMES = [
    # Common American
    "James", "John", "Michael", "David", "Robert", "William", "Richard",
    "Joseph", "Thomas", "Charles", "Christopher", "Daniel", "Matthew",
    "Anthony", "Mark", "Donald", "Steven", "Paul", "Andrew", "Kenneth",
    "Joshua", "Kevin", "Brian", "George", "Timothy", "Ronald", "Edward",
    "Jason", "Jeffrey", "Ryan", "Jacob", "Gary", "Nicholas", "Eric",
    "Jonathan", "Stephen", "Larry", "Justin", "Scott", "Brandon",
    "Benjamin", "Samuel", "Raymond", "Gregory", "Frank", "Alexander",
    "Patrick", "Jack", "Dennis", "Jerry", "Tyler", "Aaron", "Jose",
    "Henry", "Adam", "Douglas", "Nathan", "Peter", "Zachary", "Kyle",
    "Walter", "Harold", "Jeremy", "Ethan", "Carl", "Keith", "Roger",
    "Gerald", "Christian", "Terry", "Sean", "Austin", "Arthur",
    "Lawrence", "Jesse", "Dylan", "Bryan", "Joe", "Jordan", "Billy",
    "Bruce", "Albert", "Willie", "Gabriel", "Logan", "Alan", "Juan",
    "Wayne", "Roy", "Ralph", "Randy", "Eugene", "Vincent", "Russell",
    "Elijah", "Louis", "Philip", "Bobby", "Johnny", "Bradley",
    # African-American names common in football
    "Jalen", "Darius", "Malik", "Devonte", "Jamal", "Tyrese", "Keion",
    "Derrick", "Marcus", "Andre", "Devin", "Marquis", "Terrell",
    "DaShawn", "DeAndre", "Kendall", "Rashad", "Trevon", "Tre",
    "Damon", "Antwan", "Laquon", "Cedric", "Deonte", "Javon",
    "Rashaad", "Marquise", "Kentavious", "Travion", "Quinton",
    "Broderick", "Marlon", "Deshawn", "Latavius", "Arian", "Taysom",
    "Dontae", "Jameis", "Desmond", "Cre'Von", "Bashaud", "Kameron",
    "Jacoby", "Amari", "Dwayne", "Demar", "Kelvin", "Roquan",
    "Alize", "Kadeem", "Jahvid", "Tavon", "Montee", "Stedman",
    "Sammie", "Tiquan", "Cody", "Blaine", "Mason", "Hunter",
    "Cooper", "Chase", "Cole", "Carson", "Cade", "Zach", "Bryce",
    "Tanner", "Riley", "Parker", "Peyton", "Griffin", "Paxton",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
    "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark",
    "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Hall", "Allen",
    "Wright", "King", "Scott", "Green", "Baker", "Adams", "Nelson",
    "Carter", "Mitchell", "Perez", "Roberts", "Turner", "Phillips",
    "Campbell", "Parker", "Evans", "Edwards", "Collins", "Stewart",
    "Sanchez", "Morris", "Rogers", "Reed", "Cook", "Morgan", "Bell",
    "Murphy", "Bailey", "Rivera", "Cooper", "Richardson", "Cox",
    "Howard", "Ward", "Torres", "Peterson", "Gray", "Ramirez", "James",
    "Watson", "Brooks", "Kelly", "Sanders", "Price", "Bennett", "Wood",
    "Barnes", "Ross", "Henderson", "Coleman", "Jenkins", "Perry",
    "Powell", "Long", "Patterson", "Hughes", "Flores", "Washington",
    "Butler", "Simmons", "Foster", "Gonzales", "Bryant", "Alexander",
    "Russell", "Griffin", "Diaz", "Hayes", "Myers", "Ford", "Hamilton",
    "Graham", "Sullivan", "Wallace", "Woods", "Cole", "West", "Jordan",
    "Owens", "Reynolds", "Fisher", "Ellis", "Harrison", "Gibson",
    "McDonald", "Cruz", "Marshall", "Ortiz", "Gomez", "Murray",
    "Freeman", "Wells", "Webb", "Simpson", "Stevens", "Tucker",
    "Porter", "Hunter", "Hicks", "Crawford", "Henry", "Boyd",
    "Mason", "Morales", "Kennedy", "Warren", "Dixon", "Ramos",
    "Reyes", "Burns", "Gordon", "Shaw", "Holmes", "Rice", "Robertson",
    "Hunt", "Black", "Daniels", "Palmer", "Mills", "Nichols",
    "Grant", "Knight", "Ferguson", "Rose", "Stone", "Hawkins",
    "Dunn", "Perkins", "Hudson", "Spencer", "Gardner", "Stephens",
    "Payne", "Pierce", "Berry", "Matthews", "Arnold", "Wagner",
    "Willis", "Ray", "Watkins", "Olsen", "Carroll", "Duncan",
    "Snyder", "Hart", "Cunningham", "Bradley", "Lane", "Andrews",
    "Ruiz", "Harper", "Fox", "Riley", "Armstrong", "Carpenter",
]

SCHOOLS = [
    "Alabama", "Ohio State", "Georgia", "Michigan", "LSU", "Penn State",
    "Clemson", "Notre Dame", "Texas", "Oregon", "Oklahoma", "Florida",
    "Florida State", "Auburn", "Tennessee", "USC", "Miami (FL)",
    "Stanford", "Texas A&M", "Wisconsin", "Iowa", "Nebraska", "Arkansas",
    "Missouri", "Ole Miss", "Mississippi State", "Kentucky", "Vanderbilt",
    "Indiana", "Purdue", "Illinois", "Northwestern", "Minnesota",
    "Iowa State", "Kansas State", "Oklahoma State", "TCU", "Baylor",
    "West Virginia", "Pittsburgh", "Boston College", "Syracuse",
    "Virginia Tech", "North Carolina", "NC State", "Wake Forest", "Duke",
    "Louisville", "Memphis", "UCF", "Cincinnati", "Houston", "Tulane",
    "Utah", "BYU", "Arizona State", "Arizona", "Colorado", "Washington",
    "Washington State", "Oregon State", "UCLA", "California", "San Jose State",
    "Boise State", "Fresno State", "Wyoming", "Nevada", "UNLV",
    "Air Force", "Army", "Navy", "Appalachian State", "Troy",
    "Louisiana", "Georgia Southern", "Liberty", "UAB", "South Alabama",
    "Marshall", "Ohio", "Western Michigan", "Ball State", "Toledo",
    "Northern Illinois", "Central Michigan", "Eastern Michigan",
    "Bowling Green", "Buffalo", "Akron", "Kent State",
    "Connecticut", "Rutgers", "Maryland", "Temple", "Virginia",
    "North Dakota State", "South Dakota State", "Montana", "Eastern Washington",
    "Sam Houston State", "Jacksonville State", "Kennesaw State",
]

# ---------------------------------------------------------------------------
# Position-specific measurable ranges
# ---------------------------------------------------------------------------
# (height_low, height_high, weight_low, weight_high, forty_low, forty_high)
# Height as total inches; weight in lbs; 40 in seconds
POS_MEASURABLES = {
    "QB":  (73, 78, 210, 235, 4.55, 4.80),
    "HB":  (67, 73, 195, 225, 4.35, 4.60),
    "FB":  (71, 74, 230, 255, 4.55, 4.80),
    "WR":  (68, 76, 175, 215, 4.28, 4.55),
    "TE":  (74, 79, 240, 265, 4.45, 4.75),
    "T":   (76, 81, 300, 335, 4.90, 5.35),
    "G":   (74, 78, 305, 330, 5.00, 5.35),
    "C":   (73, 77, 295, 320, 5.00, 5.30),
    "DE":  (74, 79, 240, 275, 4.55, 4.80),
    "DT":  (73, 78, 285, 320, 4.85, 5.20),
    "OLB": (73, 77, 230, 255, 4.45, 4.70),
    "MLB": (72, 76, 230, 250, 4.45, 4.70),
    "CB":  (68, 74, 175, 200, 4.32, 4.55),
    "FS":  (71, 74, 195, 215, 4.38, 4.60),
    "SS":  (71, 75, 200, 225, 4.40, 4.65),
    "K":   (70, 75, 185, 210, 4.70, 5.00),
    "P":   (72, 77, 190, 215, 4.65, 5.00),
    "LS":  (73, 76, 235, 255, 4.75, 5.10),
}

# ---------------------------------------------------------------------------
# Rating variance helpers
# ---------------------------------------------------------------------------

def jitter(val: int, low: int = -8, high: int = 8) -> int:
    """Apply random jitter to a rating, clamped to [28, 99]."""
    return max(28, min(99, val + random.randint(low, high)))


def make_ratings(pos: str, defaults: dict, round_num: int) -> dict:
    """
    Build a ratings dict for a filler prospect.
    round_num in [4, 7]: higher rounds get weaker overall ratings.
    """
    # Overall penalty: round 4 = -6, round 5 = -10, round 6 = -14, round 7 = -18
    penalty = (round_num - 3) * 4

    ratings = {}
    for field, base in defaults.items():
        if field in ("personality", "devTrait", "unkRating1"):
            ratings[field] = base  # keep fixed
            continue
        if base <= 35:
            # Dump-stat: keep in 28-42 range
            ratings[field] = random.randint(28, 42)
        else:
            adj = max(28, base - penalty)
            ratings[field] = jitter(adj, -6, 6)

    # Set overall from key stats average
    ratings["overall"] = max(58, min(74, defaults.get("overall", 65) - penalty + random.randint(-4, 4)))
    return ratings


def height_str(total_inches: int) -> str:
    return f"{total_inches // 12}-{total_inches % 12}"


def infer_round(rank: int) -> int:
    if rank <= 32:   return 1
    if rank <= 96:   return 2
    if rank <= 160:  return 3
    if rank <= 224:  return 4
    if rank <= 288:  return 5
    if rank <= 320:  return 6
    return 7


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Pad draft class to TARGET_TOTAL")
    parser.add_argument("--target", type=int, default=TARGET_TOTAL)
    parser.add_argument("--seed",   type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)

    # Load existing prospects
    if not os.path.exists(INPUT_FILE):
        print(f"ERROR: {INPUT_FILE} not found — run script 5 first.")
        sys.exit(1)

    with open(INPUT_FILE, encoding="utf-8") as fh:
        prospects = json.load(fh)

    print(f"Loaded {len(prospects)} existing prospects from {os.path.basename(INPUT_FILE)}")

    if len(prospects) >= args.target:
        print(f"Already at {len(prospects)} prospects (target {args.target}) — nothing to do.")
        sys.exit(0)

    # Load POSITION_DEFAULTS from utils
    from utils.defaults import POSITION_DEFAULTS

    # Count current positions
    from collections import Counter
    pos_counts = Counter(p["pos"] for p in prospects)

    # Build names already used (normalized)
    used_names = {
        f"{p['firstName'].lower()}{p['lastName'].lower()}"
        for p in prospects
    }

    # Calculate how many of each position to add
    total_existing = len(prospects)
    total_needed   = args.target - total_existing

    # Scale POSITION_TARGETS to cover gap
    additions: dict[str, int] = {}
    for pos, target in POSITION_TARGETS.items():
        have    = pos_counts.get(pos, 0)
        to_add  = max(0, target - have)
        additions[pos] = to_add

    # If total additions < needed, add extras to the most underrepresented positions
    total_planned = sum(additions.values())
    if total_planned < total_needed:
        # Spread remaining across WR, CB, DE, OLB, T proportionally
        fill_positions = ["WR", "CB", "DE", "OLB", "T", "HB", "DT", "MLB", "FS"]
        shortfall = total_needed - total_planned
        i = 0
        while shortfall > 0:
            additions[fill_positions[i % len(fill_positions)]] += 1
            shortfall -= 1
            i += 1

    # Starting rank (after existing)
    max_rank = max((p.get("rank") or 0 for p in prospects), default=0)

    filler_prospects = []

    for pos, count in additions.items():
        if count == 0:
            continue

        defaults   = POSITION_DEFAULTS.get(pos, POSITION_DEFAULTS.get("QB"))
        meas_range = POS_MEASURABLES.get(pos, (72, 76, 220, 250, 4.60, 4.90))
        ht_low, ht_high, wt_low, wt_high, ft_low, ft_high = meas_range

        for _ in range(count):
            # Generate unique name
            attempts = 0
            while True:
                fn = random.choice(FIRST_NAMES)
                ln = random.choice(LAST_NAMES)
                key = fn.lower() + ln.lower()
                if key not in used_names or attempts > 50:
                    used_names.add(key)
                    break
                attempts += 1

            max_rank += 1
            round_num = min(7, max(4, infer_round(max_rank)))

            ht_inches = random.randint(ht_low, ht_high)
            wt        = random.randint(wt_low, wt_high)
            forty     = round(random.uniform(ft_low, ft_high), 2)

            grade_map = {4: "C", 5: "C-", 6: "D+", 7: "D"}

            ratings = make_ratings(pos, defaults, round_num)

            filler_prospects.append({
                "firstName":   fn,
                "lastName":    ln,
                "pos":         pos,
                "school":      random.choice(SCHOOLS),
                "ht":          height_str(ht_inches),
                "wt":          wt,
                "forty":       forty,
                "bench":       None,
                "vertical":    None,
                "broad_jump":  None,
                "cone":        None,
                "shuttle":     None,
                "rank":        max_rank,
                "grade":       grade_map.get(round_num, "D"),
                "notes":       "",
                "draftRound":  round_num,
                "draftPick":   max_rank,
                "ratings":     ratings,
            })

    all_prospects = prospects + filler_prospects
    # Sort: keep real prospects first, fillers at end
    all_prospects.sort(key=lambda p: (p.get("rank") or 9999))

    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(all_prospects, fh, indent=2)

    print(f"\n{'='*50}")
    print(f"  Original prospects : {total_existing}")
    print(f"  Filler added       : {len(filler_prospects)}")
    print(f"  Total written      : {len(all_prospects)}")
    print(f"\n  Position breakdown:")
    final_counts = Counter(p["pos"] for p in all_prospects)
    for pos in sorted(final_counts):
        print(f"    {pos:<6} {final_counts[pos]}")
    print(f"\n✓ Written: {OUTPUT_FILE}")
    print("  Next: node scripts/6_create_draft_class.js")


if __name__ == "__main__":
    main()
