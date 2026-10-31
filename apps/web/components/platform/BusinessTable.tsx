"use client";

import { useRouter } from "next/navigation";
import type { BusinessListItem } from "@/lib/types-platform";
import { formatDate } from "@/lib/format";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { BusinessStatusBadge, ModuleChips } from "./modules";

/** Businesses with status, modules, counts and owners; rows open the detail page. */
export function BusinessTable({ rows, compact }: { rows: BusinessListItem[]; compact?: boolean }) {
  const router = useRouter();
  return (
    <Table>
      <THead>
        <tr>
          <Th>Business</Th>
          <Th>Status</Th>
          <Th>Modules</Th>
          <Th className="text-right">Outlets</Th>
          <Th>Owners</Th>
          {!compact && <Th>Since</Th>}
        </tr>
      </THead>
      <tbody>
        {rows.map((b) => (
          <Tr key={b.id} onClick={() => router.push(`/platform/businesses/${b.id}`)} data-business={b.name}>
            <Td>
              <p className="font-semibold">{b.name}</p>
              {(b.legalName || b.phone) && <p className="text-xs text-muted">{[b.legalName, b.phone].filter(Boolean).join(" · ")}</p>}
            </Td>
            <Td>
              <BusinessStatusBadge status={b.status} />
            </Td>
            <Td className="min-w-[180px] max-w-[320px]">
              <ModuleChips modules={b.modules} max={compact ? 3 : 6} />
            </Td>
            <Td className="tabular text-right">{b._count.outlets}</Td>
            <Td className="text-muted">
              {b.owners.length ? (
                b.owners.map((o) => (
                  <span key={o.id} className="block whitespace-nowrap">
                    {o.name} {!compact && <span className="text-xs">· {o.email ?? `+91 ${o.phone}`}</span>}
                  </span>
                ))
              ) : (
                <span className="text-amber-700 dark:text-amber-300">No owner</span>
              )}
            </Td>
            {!compact && <Td className="whitespace-nowrap text-muted">{formatDate(b.createdAt)}</Td>}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
