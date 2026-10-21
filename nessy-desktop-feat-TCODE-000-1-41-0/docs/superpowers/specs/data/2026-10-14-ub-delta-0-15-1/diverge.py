import subprocess, os, sys, re, json, tempfile
REF='/Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/craft-agents-oss'
OURS='/Users/i.i.gavrikov/Desktop/work/nessy-desktop'
S=sys.argv[1]
paths=[l.strip() for l in open(os.path.join(S,'delta/all-paths.txt')) if l.strip()]
def show(tag,p):
    r=subprocess.run(['git','-C',REF,'show',f'{tag}:{p}'],capture_output=True)
    return r.stdout.decode('utf-8','replace') if r.returncode==0 else None
def norm(t):
    for a,b in [('@nessy-agent','@craft-agent'),('NESSY','CRAFT'),('Nessy','Craft'),('nessy','craft')]:
        t=t.replace(a,b)
    return t
def ourpath(p):
    cands=[p, p.replace('craft','nessy'), p.replace('Craft','Nessy'), p.replace('craft','nessy').replace('Craft','Nessy')]
    for c in cands:
        if os.path.exists(os.path.join(OURS,c)): return c
    return None
def ndiff(a,b):
    with tempfile.NamedTemporaryFile('w',delete=False) as fa, tempfile.NamedTemporaryFile('w',delete=False) as fb:
        fa.write(a); fb.write(b); na,nb=fa.name,fb.name
    r=subprocess.run(['git','diff','--no-index','--numstat',na,nb],capture_output=True,text=True)
    os.unlink(na); os.unlink(nb)
    m=r.stdout.split()
    return (int(m[0])+int(m[1])) if len(m)>=2 and m[0].isdigit() else 0
rows=[]
for p in paths:
    u134=show('v0.13.4',p); u141=show('v0.14.1',p); u151=show('v0.15.1',p)
    op=ourpath(p)
    ours=norm(open(os.path.join(OURS,op),encoding='utf-8',errors='replace').read()) if op else None
    row={'path':p,'ours':op,'in134':u134 is not None,'in141':u141 is not None,'in151':u151 is not None}
    if u141 is not None and u151 is not None: row['up_141_151']=ndiff(u141,u151)
    elif u151 is not None: row['up_141_151']='ADDED'
    else: row['up_141_151']='DELETED'
    if ours is not None:
        row['lines_ours']=ours.count('\n')
        if u134 is not None: row['div_vs_134']=ndiff(u134,ours)
        if u141 is not None: row['div_vs_141']=ndiff(u141,ours)
    rows.append(row)
json.dump(rows,open(os.path.join(S,'delta/divergence.json'),'w'),indent=1)
# summary
tot=len(rows); have=sum(1 for r in rows if r['ours']); added=sum(1 for r in rows if r['up_141_151']=='ADDED'); deleted=sum(1 for r in rows if r['up_141_151']=='DELETED')
print('paths',tot,'we-have',have,'upstream-added(0.14.1->0.15.1)',added,'deleted',deleted)
