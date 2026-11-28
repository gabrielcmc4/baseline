#!/bin/bash
# Runs run.mjs on every synthetic video in a folder (default /tmp/syn) in parallel and prints one score line per video.
D=${1:-/tmp/syn}; shift
for v in "$D"/*.mp4; do t="${v%.mp4}.truth.json"; [ -f "$t" ] || continue; case "$v" in *_test*|*/a.mp4|*/b.mp4|*/x.mp4) continue;; esac
  mode=$(python3 -c "import json,sys;print(json.load(open('$t')).get('mode','match'))" 2>/dev/null || echo match)
  ( node "$(dirname "$0")/run.mjs" "$v" "$mode" --json "${v%.mp4}.res.json" "$@" > "${v%.mp4}.out" 2>&1 ) &
done; wait
for v in "$D"/*.mp4; do o="${v%.mp4}.out"; [ -f "${v%.mp4}.res.json" ] || continue; [ "$o" -nt "$v" ] || continue
  python3 - "$v" <<'PY'
import json,sys; v=sys.argv[1]; r=json.load(open(v[:-4]+'.res.json')); s=r.get('score',{})
rows=r.get('rows',[]); nf=[x for x in rows if not x['far']]; ff=[x for x in rows if x['far']]
print(f"{v.split('/')[-1]:16s} found {s.get('matched')}/{s.get('truth')} (near {sum(1 for x in nf if x['got'])}/{len(nf)}, far {sum(1 for x in ff if x['got'])}/{len(ff)}, volleys {sum(1 for x in rows if x['volley'] and x['got'])}/{sum(1 for x in rows if x['volley'])}) extra {s.get('extra')} speedErr {s.get('speedErrMedPct')}% bias {s.get('speedBiasPct')}% land {s.get('landErrMedM')} m result {s.get('resultOk')} netPlays {len((r.get('meta') or {}).get('netPlays') or [])}")
PY
done
