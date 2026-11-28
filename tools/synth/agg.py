import json,glob,statistics as st,sys
errs=[];
for f in sorted(glob.glob('/tmp/syn/*.res.json')):
    if any(k in f for k in ('vc.json','vn.json')): continue
    r=json.load(open(f))
    for x in r.get('rows',[]):
        if x['got']: errs.append(x['got']['speed']/x['truth']['speed']-1)
a=[abs(e) for e in errs]
print(sys.argv[1] if len(sys.argv)>1 else '', 'n',len(errs),'medAbs %.1f%%'%(100*st.median(a)),'mean %.1f%%'%(100*st.mean(errs)),'p90 %.1f%%'%(100*sorted(a)[int(0.9*len(a))]))
