import io
import re

s = io.open('src/i18n/ru.ts', encoding='utf-8').read()
pattern = re.compile(r"^\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:")
keys = []
for i, line in enumerate(s.split('\n'), 1):
    m = pattern.match(line)
    if m:
        keys.append((m.group(1) or m.group(2), i))
seen = {}
dups = []
for k, ln in keys:
    if k in seen:
        dups.append((k, seen[k], ln))
    else:
        seen[k] = ln
for k, a, b in dups:
    print(f'{k}: first@{a} dup@{b}')
print('total keys:', len(keys))
