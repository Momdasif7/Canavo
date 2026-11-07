import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { otpRequestSchema, passwordLoginSchema } from "@canavo/shared";
import { SUSPENDED_RE } from "../src/auth/access";
import { useAuth } from "../src/auth/AuthContext";
import { OtpInput } from "../src/components/OtpInput";
import { AppText, Button, Card, Input, Notice } from "../src/components/ui";
import { endpoints, errorMessage } from "../src/lib/api";
import { API_URL, IS_DEV } from "../src/lib/config";
import { brand, space, useTheme } from "../src/theme";

type Mode = "otp" | "password";

export default function Login() {
  const { status, loginWithOtp, loginWithPassword, verifyTwoFactor, signOutReason } = useAuth();
  const t = useTheme();
  const [mode, setMode] = useState<Mode>("otp");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step login: ticket from the first step, then an app code or a recovery code.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  if (status === "signedIn") return <Redirect href="/(tabs)" />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const requestOtp = () =>
    run(async () => {
      const parsed = otpRequestSchema.safeParse({ phone });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid phone number");
      const res = await endpoints.requestOtp(parsed.data.phone);
      setOtpSent(true);
      setCode("");
      setDevCode(res.devCode ?? null);
      setResendIn(30);
    });

  const verifyOtp = () =>
    run(async () => {
      if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code");
      const challenge = await loginWithOtp(phone.trim(), code);
      if (challenge) setMfaToken(challenge.mfaToken);
    });

  const passwordLogin = () =>
    run(async () => {
      const parsed = passwordLoginSchema.safeParse({ email: email.trim(), password });
      if (!parsed.success) throw new Error("Enter a valid email and password");
      const challenge = await loginWithPassword(parsed.data.email, parsed.data.password);
      if (challenge) setMfaToken(challenge.mfaToken);
    });

  const verifySecondStep = () =>
    run(async () => {
      try {
        await verifyTwoFactor(mfaToken!, useRecovery ? { recoveryCode: mfaCode.trim() } : { code: mfaCode });
      } catch (e) {
        // The ticket lasts 5 minutes: start again from the first step.
        if (/expired/i.test(errorMessage(e))) {
          setMfaToken(null);
          setMfaCode("");
        }
        throw e;
      }
    });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <View style={[styles.logo, { backgroundColor: brand.saffron }]}>
              <AppText style={styles.logoText}>C</AppText>
            </View>
            <AppText variant="title">CANAVO</AppText>
            <AppText variant="muted">Canteen POS & staff app</AppText>
          </View>

          <Card style={{ gap: space.lg }}>
            {mfaToken ? (
              <>
                <AppText variant="small">
                  {useRecovery
                    ? "Enter one of the recovery codes you saved when you turned on two-step login."
                    : "Open your authenticator app and enter the 6-digit code for CANAVO."}
                </AppText>
                {useRecovery ? (
                  <Input label="Recovery code" value={mfaCode} onChangeText={setMfaCode} autoCapitalize="none" placeholder="xxxx-xxxx" maxLength={20} />
                ) : (
                  <OtpInput value={mfaCode} onChange={setMfaCode} autoFocus />
                )}
                <Button title="Verify & sign in" loading={busy} disabled={useRecovery ? mfaCode.trim().length < 8 : mfaCode.length !== 6} onPress={verifySecondStep} />
                <Button
                  title={useRecovery ? "Use the app code" : "Use a recovery code"}
                  variant="ghost"
                  size="md"
                  onPress={() => {
                    setUseRecovery((v) => !v);
                    setMfaCode("");
                    setError(null);
                  }}
                />
              </>
            ) : mode === "otp" ? (
              <>
                <Input
                  label="Mobile number"
                  value={phone}
                  onChangeText={(v) => {
                    setPhone(v.replace(/\D/g, "").slice(0, 10));
                    setOtpSent(false);
                  }}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  placeholder="98765 43210"
                  maxLength={10}
                  editable={!busy}
                />
                {otpSent ? (
                  <>
                    <AppText variant="small">Enter the 6-digit code sent to +91 {phone}</AppText>
                    <OtpInput value={code} onChange={setCode} autoFocus />
                    {devCode ? (
                      <Notice kind="info" title="Dev mode" message={`SMS is not configured. Your code is ${devCode}`} />
                    ) : null}
                    <Button title="Verify & sign in" loading={busy} disabled={code.length !== 6} onPress={verifyOtp} />
                    <Button
                      title={resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
                      variant="ghost"
                      size="md"
                      disabled={resendIn > 0 || busy}
                      onPress={requestOtp}
                    />
                  </>
                ) : (
                  <Button title="Send OTP" loading={busy} disabled={phone.length !== 10} onPress={requestOtp} />
                )}
              </>
            ) : (
              <>
                <Input
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  placeholder="you@canteen.in"
                />
                <Input
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="password"
                  onSubmitEditing={passwordLogin}
                />
                <Button title="Sign in" loading={busy} onPress={passwordLogin} />
              </>
            )}
            {error ? (
              <Notice kind="error" title={SUSPENDED_RE.test(error) ? "Account suspended" : undefined} message={error} />
            ) : signOutReason ? (
              <Notice kind="error" title={SUSPENDED_RE.test(signOutReason) ? "Account suspended" : "Signed out"} message={signOutReason} />
            ) : null}
          </Card>

          <Pressable
            onPress={() => {
              setMode(mode === "otp" ? "password" : "otp");
              setError(null);
              setMfaToken(null);
              setMfaCode("");
            }}
            style={styles.switch}
            accessibilityRole="button"
          >
            <AppText color={t.primary} style={{ fontWeight: "700" }}>
              {mode === "otp" ? "Use email & password instead" : "Use mobile OTP instead"}
            </AppText>
          </Pressable>

          {IS_DEV ? (
            <AppText variant="small" style={{ textAlign: "center" }}>
              API: {API_URL}
            </AppText>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: "center", padding: space.lg, gap: space.lg },
  brand: { alignItems: "center", gap: space.xs, marginBottom: space.md },
  logo: { width: 72, height: 72, borderRadius: 20, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  logoText: { color: "#fff", fontSize: 40, fontWeight: "900" },
  switch: { minHeight: 48, alignItems: "center", justifyContent: "center" },
});
