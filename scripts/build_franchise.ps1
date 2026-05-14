# build_franchise.ps1 — End-to-end franchise build wrapper
#
# Phase 'pre'  — Copies V20 source, swaps user team, injects 2026 rookies +
#                ratings, disposes Madden's pre-built draft pool. Produces a
#                franchise ready for in-game load + draft sim.
# Phase 'post' — Run AFTER user advances through the draft + preseason in
#                Madden. Purges any fake-named auto-rookies Madden auto-signed
#                during the UDFA wave + next-year synthetic pool.
# Phase 'both' — runs 'pre', then halts with instructions to sim in Madden.
#                Re-invoke with -Phase post on the autosave file once done.
#
# Usage:
#   ./scripts/build_franchise.ps1 -TargetTeamIndex 27 -DestName CAREER-HAWKS-FINAL -Phase pre
#   # (load in Madden, sim through draft + preseason to Week 1, save autosave)
#   ./scripts/build_franchise.ps1 -DestName CAREER-HAWKS-FINAL -Phase post
#
#   # With custom ratings / rookies files (skips data-generation phase):
#   ./scripts/build_franchise.ps1 -TargetTeamIndex 27 -DestName CAREER-LOVE-TEST -Phase pre `
#     -Ratings data\roster_players_rated_full2.json `
#     -Rookies data\rookie_ratings_post_fix.json
#   ./scripts/build_franchise.ps1 -DestName CAREER-LOVE-TEST -Phase post `
#     -Rookies data\rookie_ratings_post_fix.json
#
#   # With skin-tone visuals (requires data/rookie_appearances.json already built;
#   # see commands.md "Rookie visuals (skin-tone)" for the one-time build):
#   ./scripts/build_franchise.ps1 -TargetTeamIndex 27 -DestName CAREER-LOVE-TEST -Phase pre `
#     -Ratings data\roster_players_rated_full2.json `
#     -Rookies data\rookie_ratings_post_fix.json `
#     -ApplyVisuals
#
#   # With current veteran contracts overlaid (requires OTC-merged
#   # data/nfl_rosters_2026.json from 7b/7c):
#   ./scripts/build_franchise.ps1 -TargetTeamIndex 27 -DestName CAREER-LOVE-TEST -Phase pre `
#     -ApplyVetContracts
#
# TeamIndex map: 0=Bears 1=Bengals 2=Bills 3=Broncos 4=Browns 5=Buccaneers
# 6=Cardinals 7=Chargers 8=Chiefs 9=Colts 10=Cowboys 11=Dolphins 12=Eagles
# 13=Falcons 14=49ers 15=Giants 16=Jaguars 17=Jets 18=Lions 19=Packers
# 20=Panthers 21=Patriots 22=Raiders 23=Rams 24=Ravens 25=Commanders
# 26=Saints 27=Seahawks 28=Steelers 29=Titans 30=Vikings 31=Texans

param(
  [Parameter(Mandatory=$true)]
  [string]$DestName,

  [int]$TargetTeamIndex = -1,

  [string]$Source = "CAREER-UPDATED-ROSTER",

  [ValidateSet('pre', 'post')]
  [string]$Phase = 'pre',

  # Optional: override 9g's veteran ratings input. Forwarded to 9g as --ratings.
  # Default (when omitted): 9g uses data/full_solution_2_ratings.json.
  [string]$Ratings,

  # Optional: override 9g + 9m's rookie ratings input. Forwarded as --rookies.
  # 9m uses this as the keep-list when purging fake auto-rookies.
  # Default (when omitted): both use data/rookie_ratings_post_madden.json.
  [string]$Rookies,

  # Optional: also apply per-rookie skin-tone visuals via 9p_apply_visuals.js
  # after the rookie injection step. Reads data/rookie_appearances.json
  # (built by the 9n/9o pipeline). See docs/llm-wiki/commands.md for the
  # one-time build.
  [switch]$ApplyVisuals,

  # Optional: overlay current veteran contracts onto the franchise. Forwards
  # --apply-vet-contracts to 9g, which also auto-enables resign-table
  # regeneration. Requires OTC-merged data/nfl_rosters_2026.json (built by
  # 7b/7c). See docs/llm-wiki/decisions.md for why this is opt-in.
  [switch]$ApplyVetContracts,

  # Optional: override the appearances file path (forwarded to 9p as
  # --appearances). Only used when -ApplyVisuals is set.
  [string]$Appearances
)

$ErrorActionPreference = 'Stop'

$savesDir = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves"
$srcPath  = Join-Path $savesDir $Source
$dstPath  = Join-Path $savesDir $DestName
$autoPath = Join-Path $savesDir "$DestName-AUTOSAVE"
$repo     = Split-Path -Parent $PSScriptRoot

function Step($msg) {
  Write-Host ""
  Write-Host ("=" * 64) -ForegroundColor Cyan
  Write-Host $msg -ForegroundColor Cyan
  Write-Host ("=" * 64) -ForegroundColor Cyan
}

if ($Phase -eq 'pre') {
  if ($TargetTeamIndex -lt 0 -or $TargetTeamIndex -gt 31) {
    throw "Phase 'pre' requires -TargetTeamIndex 0..31"
  }
  if (-not (Test-Path $srcPath)) {
    throw "Source not found: $srcPath"
  }

  Step "Step 1: Copy V20 source → $DestName"
  Copy-Item -Path $srcPath -Destination $dstPath -Force
  Write-Host "Copied: $((Get-Item $dstPath).Length) bytes"

  Step "Step 2: 9k — swap user team to TeamIndex $TargetTeamIndex"
  & node "$repo\scripts\9k_swap_user_team.js" --franchise $dstPath --target-team-index $TargetTeamIndex
  if ($LASTEXITCODE -ne 0) { throw "9k failed" }

  Step "Step 3: 9z_validate_franchise"
  & node "$repo\scripts\9z_validate_franchise.js" --franchise $dstPath
  if ($LASTEXITCODE -ne 0) { throw "validator failed" }

  Step "Step 4: 9g — inject 2026 rookies + update vet ratings"
  $g9Args = @('--franchise', $dstPath, '--apply', '--allow-unmatched')
  if ($Ratings) { $g9Args += '--ratings', $Ratings }
  if ($Rookies) { $g9Args += '--rookies', $Rookies }
  if ($ApplyVetContracts) { $g9Args += '--apply-vet-contracts' }
  & node "$repo\scripts\9g_sync_franchise_from_data.js" @g9Args
  if ($LASTEXITCODE -ne 0) { throw "9g failed" }

  Step "Step 5: 9l — dispose Madden's pre-built draft pool"
  & node "$repo\scripts\9l_dispose_auto_prospects.js" --franchise $dstPath
  if ($LASTEXITCODE -ne 0) { throw "9l failed" }

  if ($ApplyVisuals) {
    Step "Step 5b: 9p — apply rookie skin-tone visuals"
    $p9Args = @('--franchise', $dstPath, '--apply')
    if ($Appearances) { $p9Args += '--appearances', $Appearances }
    & node "$repo\scripts\9p_apply_visuals.js" @p9Args
    if ($LASTEXITCODE -ne 0) { throw "9p failed" }
  }

  Step "Step 6: Final pre-sim validate"
  & node "$repo\scripts\9z_validate_franchise.js" --franchise $dstPath
  if ($LASTEXITCODE -ne 0) { throw "validator failed" }

  Write-Host ""
  Write-Host "=" * 64 -ForegroundColor Green
  Write-Host "Phase 'pre' complete. Next steps:" -ForegroundColor Green
  Write-Host "=" * 64 -ForegroundColor Green
  Write-Host "  1. Load $DestName in Madden NFL 26."
  Write-Host "  2. Confirm controlling the new team and rosters look right."
  Write-Host "  3. Advance through the draft + preseason to Week 1."
  Write-Host "  4. QUIT MADDEN without manually saving (let autosave persist)."
  Write-Host "  5. Run phase 'post' to purge auto-generated UDFAs:"
  Write-Host ""
  Write-Host "       ./scripts/build_franchise.ps1 -DestName $DestName -Phase post" -ForegroundColor Yellow
}
elseif ($Phase -eq 'post') {
  if (-not (Test-Path $autoPath)) {
    throw "Autosave not found at: $autoPath`nExpected after phase 'pre' + in-game sim."
  }

  Step "Phase 'post' — purge auto-generated rookies on $DestName-AUTOSAVE"
  $m9Args = @('--franchise', $autoPath, '--include-yd1')
  if ($Rookies) { $m9Args += '--rookies', $Rookies }
  & node "$repo\scripts\9m_purge_fake_rookies.js" @m9Args
  if ($LASTEXITCODE -ne 0) { throw "9m failed" }

  Step "Final validate"
  & node "$repo\scripts\9z_validate_franchise.js" --franchise $autoPath
  if ($LASTEXITCODE -ne 0) { throw "validator failed" }

  Write-Host ""
  Write-Host "=" * 64 -ForegroundColor Green
  Write-Host "Phase 'post' complete. Final franchise at:" -ForegroundColor Green
  Write-Host "  $autoPath" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Quit Madden if running, then reload — fakes purged."
}
