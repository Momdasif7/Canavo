# Model tenancy inventory from schema.prisma + db.ts BUSINESS_SCOPED_MODELS.
import re, os
root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
schema = open(f"{root}/apps/api/prisma/schema.prisma").read()
db = open(f"{root}/apps/api/src/db.ts").read()
scoped = set(re.findall(r'"(\w+)"', db[db.index("BUSINESS_SCOPED_MODELS"):db.index("]);")]))
rows = []
for name, body in re.findall(r"^model (\w+) \{\n(.*?)^\}", schema, re.S | re.M):
    fields = re.findall(r"^\s+(\w+)\s+([\w\[\]?]+)", body, re.M)
    names = {f for f, _ in fields}
    rels = [t.strip("?[]") for f, t in fields if t.strip("?[]")[0].isupper() and t.strip("?[]") not in ("String","Int","Float","Boolean","DateTime","Json","Decimal","BigInt","Bytes")]
    path = "businessId" if "businessId" in names else ("outletId → Outlet.businessId" if "outletId" in names else ("via " + ", ".join(sorted(set(r for r in rels if r in ("Order","MenuItem","User","Customer","Offer","Coupon","InventoryItem","Delivery","TableSession","Purchase","Vendor","StockAudit","StockTransfer","Business","Outlet")))) if rels else "—"))
    rows.append((name, "yes" if "businessId" in names else "", "yes" if "outletId" in names else "", "yes" if name in scoped else "", path))
out = f"{root}/docs/build/model-scope.csv"
with open(out, "w") as f:
    f.write("Model,businessId,outletId,Auto-filtered by tenant extension,Tenant path\n")
    for r in rows: f.write(",".join(f'"{c}"' if "," in c else c for c in r) + "\n")
print(len(rows), "models;", sum(1 for r in rows if r[1]), "with businessId;", sum(1 for r in rows if not r[1] and r[2]), "outlet-only;", sum(1 for r in rows if not r[1] and not r[2]), "neither")
print("NEITHER:", [r[0]+" ("+r[4]+")" for r in rows if not r[1] and not r[2]])
