import re, sys, os
S = sys.argv[1]
d1 = {l.split('\t')[2].strip() for l in open(os.path.join(S,'d1-0141.tsv')) if l.strip()}
paths = [l.strip() for l in open(os.path.join(S,'all-paths.txt')) if l.strip()]
b = {k: [] for k in ['B1','B2','B3','B4','B5']}
for p in paths:
    if p in d1 or re.search(r'decision|adaptive-thinking|guarded-mode|large-results|relevance|semantic-labels', p):
        b['B1'].append(p)
    elif 'browser' in p.lower() and 'ServerDirectoryBrowser' not in p:
        b['B5'].append(p)
    elif re.match(r'(packages/shared/src/labels|packages/shared/src/automations|packages/session-tools-core|packages/shared/src/sources|packages/server-core/src/(?!decisions)|packages/shared/src/tasks|packages/shared/src/projects|packages/core/)', p) or re.search(r'label|automation|task|source|mcp|memory|attachment|auth|oauth', p, re.I) and not p.startswith('packages/ui/') and 'renderer/components/ui/' not in p:
        b['B4'].append(p)
    elif re.match(r'(packages/shared/src/agent|packages/pi-agent-server|packages/shared/src/config|packages/shared/src/model|package\.json$|bun\.lock$|packages/[^/]+/package\.json$|packages/shared/)', p):
        b['B2'].append(p)
    else:
        b['B3'].append(p)
for k,v in b.items():
    open(os.path.join(S,f'{k}-paths.txt'),'w').write('\n'.join(v)+'\n')
    print(k, len(v))
print('total', sum(len(v) for v in b.values()), 'of', len(paths))
