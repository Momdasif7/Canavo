# RBAC truth table

Generated from `packages/shared/src/rbac.ts` + `modules.ts` by `rbac.test.ts` (`WRITE_RBAC_TABLE=1`). A permission is **effective** only when the role has it **and** its module is enabled for the business. Snapshot-tested: any change fails CI until reviewed.

| Permission | Module | SA | Owner | Mgr | Cash | Kit | Del | Inv |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `outlet:manage` | always on | · | ✅ | · | · | · | · | · |
| `settings:billing` | always on | · | ✅ | ✅ | · | · | · | · |
| `settings:outlet` | always on | · | ✅ | ✅ | · | · | · | · |
| `staff:manage` | always on | · | ✅ | ✅ | · | · | · | · |
| `staff:view` | always on | · | ✅ | ✅ | · | · | · | · |
| `attendance:self` | ATTENDANCE | · | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `attendance:manage` | ATTENDANCE | · | ✅ | ✅ | · | · | · | · |
| `menu:manage` | BILLING or INVENTORY | · | ✅ | ✅ | · | · | · | · |
| `menu:view` | BILLING or INVENTORY | · | ✅ | ✅ | ✅ | ✅ | · | ✅ |
| `order:create` | BILLING | · | ✅ | ✅ | ✅ | · | · | · |
| `order:view` | BILLING | · | ✅ | ✅ | ✅ | · | · | · |
| `order:cancel` | BILLING | · | ✅ | ✅ | · | · | · | · |
| `payment:collect` | BILLING | · | ✅ | ✅ | ✅ | · | · | · |
| `kot:view` | KOT | · | ✅ | ✅ | ✅ | ✅ | · | · |
| `kot:update` | KOT | · | ✅ | ✅ | · | ✅ | · | · |
| `report:view` | REPORTS | · | ✅ | ✅ | · | · | · | · |
| `inventory:manage` | INVENTORY | · | ✅ | ✅ | · | · | · | ✅ |
| `delivery:own` | DELIVERY | · | · | · | · | · | ✅ | · |
| `table:manage` | TABLES | · | ✅ | ✅ | · | · | · | · |
| `table:serve` | TABLES | · | ✅ | ✅ | ✅ | · | · | · |
| `reservation:manage` | RESERVATIONS | · | ✅ | ✅ | ✅ | · | · | · |
| `delivery:manage` | DELIVERY | · | ✅ | ✅ | ✅ | · | · | · |
| `customer:view` | CUSTOMERS | · | ✅ | ✅ | ✅ | · | · | · |
| `customer:manage` | CUSTOMERS | · | ✅ | ✅ | · | · | · | · |
| `offer:manage` | OFFERS | · | ✅ | ✅ | · | · | · | · |
| `inventory:view` | INVENTORY | · | ✅ | ✅ | · | ✅ | · | ✅ |
| `audit:view` | always on | ✅ | ✅ | ✅ | · | · | · | · |
| `admin:backup` | always on | ✅ | · | · | · | · | · | · |
| `platform:manage` | always on | ✅ | · | · | · | · | · | · |
| `bills:view` | BILLING | · | ✅ | ✅ | ✅ | · | · | · |
| `settings:view` | always on | · | ✅ | ✅ | ✅ | · | · | · |
| `data:export` | always on | · | ✅ | · | · | · | · | · |
