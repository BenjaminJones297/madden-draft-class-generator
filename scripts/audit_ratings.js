'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const prospects = require(path.join(ROOT, 'data', 'prospects_rated.json'));
const cal       = require(path.join(ROOT, 'data', 'calibration_set.json'));

function stats(arr) {
  if (!arr.length) return null;
  const min = Math.min(...arr), max = Math.max(...arr);
  return { min, max, avg: Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) };
}

const byPos = {};
prospects.forEach(p => (byPos[p.pos] = byPos[p.pos]||[]).push(p));

// Known calibration contamination
const CAL_PROXY = { CB:'FS', DE:'OLB', DT:null };

const AUDIT = {
  QB:  ['throwPower','throwAccuracyShort','throwAccuracyMid','throwAccuracyDeep','throwOnRun','throwUnderPressure','speed','agility','acceleration','stamina','awareness','changeOfDirection'],
  HB:  ['speed','acceleration','agility','stamina','elusiveness','carrying','ballCarrierVision','trucking','spinMove','jukeMove','stiffArm','breakTackle','passBlock','catching','jumping','kickReturn'],
  WR:  ['speed','catching','catchInTraffic','shortRouteRunning','mediumRouteRunning','deepRouteRunning','release','jumping','kickReturn','stamina','awareness'],
  TE:  ['speed','catching','catchInTraffic','shortRouteRunning','mediumRouteRunning','deepRouteRunning','release','runBlock','passBlock','stamina','jumping'],
  T:   ['passBlockPower','passBlockFinesse','runBlock','strength','awareness','changeOfDirection','jumping','stamina'],
  G:   ['passBlockPower','passBlockFinesse','runBlock','strength','awareness','changeOfDirection','jumping','stamina'],
  C:   ['passBlockPower','passBlockFinesse','runBlock','strength','awareness','changeOfDirection','jumping','stamina'],
  DE:  ['speed','acceleration','agility','strength','blockShedding','powerMoves','finesseMoves','pursuit','stamina','awareness','changeOfDirection','jumping'],
  DT:  ['speed','acceleration','agility','strength','blockShedding','powerMoves','finesseMoves','pursuit','stamina','awareness'],
  OLB: ['speed','acceleration','agility','strength','pursuit','tackle','hitPower','blockShedding','stamina','awareness','jumping','manCoverage','zoneCoverage'],
  MLB: ['speed','acceleration','agility','strength','pursuit','tackle','hitPower','blockShedding','stamina','awareness'],
  CB:  ['speed','acceleration','agility','manCoverage','zoneCoverage','catching','catchInTraffic','pursuit','tackle','hitPower','stamina','jumping','kickReturn','awareness'],
  FS:  ['speed','acceleration','agility','manCoverage','zoneCoverage','catching','catchInTraffic','pursuit','tackle','hitPower','stamina','jumping','awareness','changeOfDirection'],
  SS:  ['speed','acceleration','agility','manCoverage','zoneCoverage','catching','catchInTraffic','pursuit','tackle','hitPower','stamina','jumping','awareness','changeOfDirection'],
};

console.log('\n=== FULL AUDIT ===\n');

for (const [pos, attrs] of Object.entries(AUDIT)) {
  const group = byPos[pos];
  if (!group || !group.length) continue;
  const calKey = CAL_PROXY[pos] !== undefined ? CAL_PROXY[pos] : pos;
  const calGroup = (calKey && cal[calKey]) ? cal[calKey] : null;
  const issues = [];

  for (const attr of attrs) {
    const ours = group.map(p => p.ratings[attr]).filter(v => v !== undefined);
    if (!ours.length) continue;
    const ourS = stats(ours);
    const isGhost = (ourS.max - ourS.min) <= 3;

    let calS = null;
    if (calGroup && calGroup.length) {
      const calVals = calGroup.map(p => p[attr]).filter(v => v !== undefined && v > 0);
      if (calVals.length) calS = stats(calVals);
    }

    const flags = [];
    if (isGhost) flags.push('GHOST');
    if (calS) {
      if (ourS.avg < calS.min - 5) flags.push('BELOW_CAL');
      if (ourS.avg > calS.max + 5) flags.push('ABOVE_CAL');
    }
    if (flags.length) issues.push({ attr, ourS, calS, flags });
  }

  if (issues.length) {
    console.log('[' + pos + '] ' + group.length + ' players');
    for (const { attr, ourS, calS, flags } of issues) {
      const calStr = calS
        ? '  cal: min=' + calS.min + ' avg=' + calS.avg + ' max=' + calS.max
        : '  no cal';
      console.log('  ' + attr.padEnd(25) + 'our: min=' + ourS.min + ' avg=' + ourS.avg + ' max=' + ourS.max + calStr + '  [' + flags.join(',') + ']');
    }
  }
}
