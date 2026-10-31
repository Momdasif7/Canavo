import React from "react";
import { can, type Permission } from "@canavo/shared";
import { Screen } from "../components/Screen";
import { FeatureOff } from "../components/ui";
import { useAuth } from "./AuthContext";

/**
 * Screen guard on /auth/me effective permissions. Hidden tabs and menu rows
 * already keep users away; this covers deep links, notifications and a
 * business whose modules change while the app is open.
 */
export function RequireAccess({
  anyOf,
  children,
}: {
  /** Shown when the user has at least one of these permissions */
  anyOf: Permission[];
  children: React.ReactNode;
}) {
  const { me, allowed } = useAuth();
  if (!me || anyOf.some(allowed)) return <>{children}</>;
  // The role has it but the business doesn't → module off; otherwise a plain role restriction.
  const moduleOff = anyOf.some((p) => can(me.role, p));
  return (
    <Screen scroll={false}>
      {moduleOff ? (
        <FeatureOff />
      ) : (
        <FeatureOff title="Not available for your role" message="Ask your manager if you need access to this screen." />
      )}
    </Screen>
  );
}

/** Wrap a route component with <RequireAccess>. */
export function withAccess<P extends object>(anyOf: Permission[], Component: React.ComponentType<P>) {
  function Guarded(props: P) {
    return (
      <RequireAccess anyOf={anyOf}>
        <Component {...props} />
      </RequireAccess>
    );
  }
  Guarded.displayName = `withAccess(${Component.displayName ?? Component.name ?? "Screen"})`;
  return Guarded;
}
