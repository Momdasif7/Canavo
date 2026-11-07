"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { ShieldCheck } from "@phosphor-icons/react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Alert, LoadingState } from "@/components/ui/States";

/** A manager's approval typed on this device (Phase 3.3, feature APPROVAL_PINS). */
export interface Approval {
  approverId: string;
  pin: string;
}

interface Approver {
  id: string;
  name: string;
  role: string;
}

type WithApproval = <T>(run: (approval?: Approval) => Promise<T>) => Promise<T>;

const ApprovalContext = createContext<WithApproval>((run) => run());

/** True when the API says a manager's PIN is needed for this action. */
export const isApprovalRequired = (e: unknown) => e instanceof ApiError && (e.details as { code?: string } | undefined)?.code === "APPROVAL_REQUIRED";
/** Wrong / locked approver PIN: ask again instead of failing the action. */
const isPinProblem = (e: unknown) => e instanceof ApiError && ["WRONG_PIN", "APPROVER_INVALID", "PIN_REQUIRED"].includes((e.details as { code?: string } | undefined)?.code ?? "");

/**
 * `withApproval(run)`: runs the request; if the API answers APPROVAL_REQUIRED, asks for a
 * manager and their PIN and runs it again with `approval` — until it succeeds or is cancelled.
 */
export function ApprovalProvider({ children }: { children: React.ReactNode }) {
  const [ask, setAsk] = useState<{ message: string; error: string | null } | null>(null);
  const [approvers, setApprovers] = useState<Approver[] | null>(null);
  const [approverId, setApproverId] = useState("");
  const [pin, setPin] = useState("");
  const pending = useRef<{ resolve: (a: Approval | null) => void } | null>(null);

  const prompt = useCallback(async (message: string, error: string | null = null): Promise<Approval | null> => {
    if (!approvers) {
      try {
        const r = await api.get<{ approvers: Approver[] }>("/orders/approvers");
        setApprovers(r.approvers);
        if (r.approvers.length === 1) setApproverId(r.approvers[0]!.id);
      } catch {
        setApprovers([]);
      }
    }
    setPin("");
    setAsk({ message, error });
    return new Promise((resolve) => (pending.current = { resolve }));
  }, [approvers]);

  const close = (a: Approval | null) => {
    setAsk(null);
    pending.current?.resolve(a);
    pending.current = null;
  };

  const withApproval: WithApproval = useCallback(
    async (run) => {
      try {
        return await run();
      } catch (e) {
        if (!isApprovalRequired(e)) throw e;
        let message = errorMessage(e);
        let problem: string | null = null;
        for (;;) {
          const approval = await prompt(message, problem);
          if (!approval) throw new ApiError(403, "Not approved");
          try {
            return await run(approval);
          } catch (err) {
            if (!isPinProblem(err)) throw err;
            problem = errorMessage(err);
            message = errorMessage(e);
          }
        }
      }
    },
    [prompt],
  );

  return (
    <ApprovalContext.Provider value={withApproval}>
      {children}
      <Dialog
        open={ask !== null}
        onClose={() => close(null)}
        size="sm"
        title="Manager approval"
        description={ask?.message}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button icon={<ShieldCheck size={20} />} disabled={!approverId || !/^\d{4,6}$/.test(pin)} onClick={() => close({ approverId, pin })}>
              Approve
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (approverId && /^\d{4,6}$/.test(pin)) close({ approverId, pin });
          }}
        >
          {ask?.error && <Alert>{ask.error}</Alert>}
          {approvers === null ? (
            <LoadingState />
          ) : approvers.length === 0 ? (
            <Alert tone="warning">No manager or owner at this outlet has a PIN set. Set one under Staff → Edit.</Alert>
          ) : (
            <>
              <Select label="Manager" value={approverId} onChange={(e) => setApproverId(e.target.value)}>
                <option value="">Choose…</option>
                {approvers.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <Input label="Manager's PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={6} autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
              <p className="text-xs text-muted">The manager types their own PIN. Who approved is recorded for the exceptions report.</p>
            </>
          )}
        </form>
      </Dialog>
    </ApprovalContext.Provider>
  );
}

export const useApproval = () => useContext(ApprovalContext);
