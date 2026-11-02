import clsx from "clsx";

export function Table({ className, ...rest }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={clsx("w-full border-collapse text-left text-sm", className)} {...rest} />
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="bg-surface-2 text-xs font-semibold uppercase tracking-wide text-muted">{children}</thead>;
}

export function Th({ className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={clsx("ui-cell whitespace-nowrap px-4 py-3", className)} {...rest} />;
}

export function Td({ className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={clsx("ui-cell border-t border-line px-4 py-3 align-middle text-fg", className)} {...rest} />;
}

export function Tr({ className, onClick, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={clsx(onClick && "cursor-pointer hover:bg-surface-2", className)} onClick={onClick} {...rest} />;
}
