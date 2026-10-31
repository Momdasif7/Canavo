import React from "react";
import { Redirect } from "expo-router";
import { useAuth } from "../src/auth/AuthContext";
import { Loading } from "../src/components/ui";

export default function Index() {
  const { status } = useAuth();
  if (status === "loading") return <Loading label="Starting CANAVO…" />;
  return <Redirect href={status === "signedIn" ? "/(tabs)" : "/login"} />;
}
