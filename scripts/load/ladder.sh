#!/bin/bash
# Usage: L=<dir with load.env + seed.json> scripts/load/ladder.sh "<name>:<biz>:<agents>:<steadySec>:<rampSec>[:heavy]" ...
set -a; . "$L/load.env"; set +a
for spec in "$@"; do
  IFS=: read -r name biz agents steady ramp heavy <<< "$spec"
  node scripts/load/reset.mjs >/dev/null
  echo "=== $name: $biz business(es) x $agents agents, ramp ${ramp}s, steady ${steady}s"
  SEED=$L/seed.json BIZ_LIMIT=$biz AGENTS_PER_BIZ=$agents DURATION=$steady RAMP=$ramp HEAVY_BIZ=${heavy:-0} SERVER_PORTS=${SERVER_PORTS:-3300} BASE=${BASE:-http://127.0.0.1:3300} OUT=$L/result-$name.json node scripts/load/run.mjs > $L/summary-$name.json 2>$L/run-$name.err
  sleep 20 # let in-flight calls finish before checking invariants
  curl -s -H "authorization: Bearer $CRON_SECRET" ${BASE:-http://127.0.0.1:3300}/api/jobs/events >/dev/null
  node scripts/load/verify.mjs > $L/verify-$name.txt 2>&1; echo "verify exit $?" >> $L/verify-$name.txt
  node -e "const s=require('$L/summary-$name.json');console.log(JSON.stringify({agents:s.scenario.agents,req:s.totals.requests,rps:s.totals.rps,errRate:s.totals.technicalErrorRate,p95:s.totals.p95,p99:s.totals.p99,crmP95:s.totals.crmP95,calls:s.counters.calls,peakLive:s.peakLiveCalls,dbl:s.counters.doubleClickMismatch,mgrDelayP95:s.managerViewDelayMs.p95,db:s.resources.maxDbConnections,cpu:s.resources.maxCpu,rss:s.resources.maxRssMb,events:s.resources.maxEventsOpen}))"
  grep -E "❌|⚠️|verify exit" $L/verify-$name.txt
done
