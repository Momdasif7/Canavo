import type { PrismaClient } from "@prisma/client";

/** Demo data for the service module. Idempotent: each part is skipped if already present. */
export async function seedService(prisma: PrismaClient): Promise<void> {
  const outlet = await prisma.outlet.findFirst({ orderBy: { createdAt: "asc" } });
  if (!outlet) return;

  await prisma.outlet.update({ where: { id: outlet.id }, data: { deliveryEnabled: true, packagingCharge: 500 } });

  // Floor plan: Main Hall (2 rows × 4) and Terrace (4 round tables).
  if (!(await prisma.diningArea.count({ where: { outletId: outlet.id } }))) {
    const hall = await prisma.diningArea.create({ data: { outletId: outlet.id, name: "Main Hall", sortOrder: 0 } });
    const terrace = await prisma.diningArea.create({ data: { outletId: outlet.id, name: "Terrace", sortOrder: 1 } });
    const hallCaps = [2, 2, 4, 6, 4, 4, 4, 8];
    for (let i = 0; i < 8; i++) {
      const cap = hallCaps[i];
      await prisma.diningTable.upsert({
        where: { outletId_label: { outletId: outlet.id, label: `T${i + 1}` } },
        update: {},
        create: {
          outletId: outlet.id,
          areaId: hall.id,
          label: `T${i + 1}`,
          capacity: cap,
          shape: cap >= 6 ? "RECTANGLE" : "SQUARE",
          posX: 1 + (i % 4) * 5,
          posY: 1 + Math.floor(i / 4) * 5,
          width: cap >= 6 ? 4 : 2,
          height: 2,
        },
      });
    }
    for (let i = 0; i < 4; i++) {
      await prisma.diningTable.upsert({
        where: { outletId_label: { outletId: outlet.id, label: `P${i + 1}` } },
        update: {},
        create: {
          outletId: outlet.id,
          areaId: terrace.id,
          label: `P${i + 1}`,
          capacity: 4,
          shape: "ROUND",
          posX: 1 + (i % 2) * 5,
          posY: 1 + Math.floor(i / 2) * 5,
          width: 3,
          height: 3,
        },
      });
    }
    console.info("Seeded 2 dining areas and 12 tables");
  }

  if (!(await prisma.deliveryZone.count({ where: { outletId: outlet.id } }))) {
    await prisma.deliveryZone.createMany({
      data: [
        { outletId: outlet.id, name: "Nearby (0–3 km)", radiusKm: 3, fee: 2000, minOrder: 0, etaMinutes: 30 },
        { outletId: outlet.id, name: "City (3–6 km)", radiusKm: 6, fee: 4000, minOrder: 15000, etaMinutes: 45 },
      ],
    });
    console.info("Seeded 2 delivery zones");
  }

  // One reservation for this evening (20:00 IST, or 3h from now if that has passed).
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone }).format(new Date());
  const dayStart = new Date(`${today}T00:00:00+05:30`);
  // Open-ended window: after ~21:00 IST the demo booking moves past midnight, and a same-day
  // re-run must still find it (a bounded "today" window seeded a duplicate).
  const existing = await prisma.reservation.count({
    where: { outletId: outlet.id, customerPhone: "9845012345", reservedFor: { gte: dayStart } },
  });
  if (!existing) {
    const evening = new Date(`${today}T20:00:00+05:30`);
    const reservedFor = evening.getTime() > Date.now() + 60 * 60_000 ? evening : new Date(Date.now() + 3 * 3_600_000);
    const table = await prisma.diningTable.findFirst({ where: { outletId: outlet.id, label: "T4" } });
    const items = await prisma.menuItem.findMany({ where: { status: "AVAILABLE", variants: { none: {} } }, take: 2, orderBy: { name: "asc" } });
    await prisma.reservation.create({
      data: {
        outletId: outlet.id,
        tableId: table?.id,
        customerName: "Priya Sharma",
        customerPhone: "9845012345",
        partySize: 5,
        reservedFor,
        durationMin: 90,
        notes: "Birthday dinner — window side",
        preOrderItems: items.map((m) => ({ menuItemId: m.id, addonIds: [], quantity: 2 })),
        advancePaid: 50000,
      },
    });
    console.info(`Seeded reservation for ${reservedFor.toISOString()}`);
  }
}
