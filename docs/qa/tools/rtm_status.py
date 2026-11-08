# Fill RTM status + manual test-case IDs (QA Phase 16). Run after requirements.py:
#   python3 docs/qa/tools/rtm_status.py
import csv, collections, os, re
D = os.path.join(os.path.dirname(__file__), "..")
AS_OF = "2026-11-09"
man = collections.defaultdict(list)
for r in csv.DictReader(open(f"{D}/manual/MANUAL_TEST_CASES.csv", encoding="utf-8-sig")):
    for ref in re.split(r"[ ,;]+", r["RTM ref"].strip()):
        if ref: man[ref].append((r["TC ID"], r["Status"].strip()))
rows = list(csv.reader(open(f"{D}/RTM.csv", encoding="utf-8-sig")))
head, body = rows[0], rows[1:]
mods = collections.OrderedDict()
for r in body:
    tcs = man.get(r[0], [])
    done = sum(1 for _, s in tcs if s.lower() in ("pass", "passed"))
    r[5] = (f"{tcs[0][0]} … {tcs[-1][0]} ({len(tcs)} manual)" if len(tcs) > 1 else tcs[0][0] + " (1 manual)" if tcs else "automated only")
    r[7] = f"Automated: pass ({AS_OF})" + (f"; manual: {done}/{len(tcs)} executed" if tcs else "")
    m = mods.setdefault(r[1], [0, 0, 0]); m[0] += 1; m[1] += len(tcs); m[2] += done
with open(f"{D}/RTM.csv", "w", newline="", encoding="utf-8") as f:
    csv.writer(f).writerows([head] + body)
md = open(f"{D}/RTM.md", encoding="utf-8").read()
table = "| Module | Requirements | Status |\n|---|---|---|\n" + "".join(
    f"| {k} | {n} | Automated: pass · manual {d}/{c} executed |\n" for k, (n, c, d) in mods.items())
table += f"| **Total** | **{sum(v[0] for v in mods.values())}** | manual cases linked: {sum(v[1] for v in mods.values())} |"
md = re.sub(r"\| Module \| Requirements \| Status \|.*?\| \*\*Total\*\* \|[^\n]*", table, md, flags=re.S)
open(f"{D}/RTM.md", "w", encoding="utf-8").write(md)
print(f"{len(body)} requirements; {sum(v[1] for v in mods.values())} manual case links")
