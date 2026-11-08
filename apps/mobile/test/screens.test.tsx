/** Screen-level tests: login (OTP / password / two-step) and payment (cash with change, error, already paid). */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { mockFetch, tokens } from "./helpers";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
const mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: mockRouter,
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  Redirect: ({ href }: { href: string }) => {
    const { Text } = jest.requireActual("react-native");
    return <Text>{`redirect:${href}`}</Text>;
  },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-qrcode-svg", () => () => null);
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

const mockAuth = {
  status: "signedOut" as string,
  me: { id: "u1", role: "CASHIER" } as unknown,
  signOutReason: null as string | null,
  allowed: () => true,
  loginWithOtp: jest.fn(async (_p: string, _c: string): Promise<unknown> => null),
  loginWithPassword: jest.fn(async (_e: string, _p: string): Promise<unknown> => null),
  verifyTwoFactor: jest.fn(async (_t: string, _i: object): Promise<void> => undefined),
};
jest.mock("../src/auth/AuthContext", () => ({ useAuth: () => mockAuth }));
jest.mock("../src/offline/OfflineContext", () => ({ useOffline: () => ({ online: true, pendingCount: 0, syncing: false, syncNow: jest.fn() }) }));

const { api } = require("../src/lib/api") as typeof import("../src/lib/api");
const Login = (require("../app/login") as { default: React.ComponentType }).default;
const Payment = (require("../app/payment/[orderId]") as { default: React.ComponentType }).default;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.status = "signedOut";
  mockAuth.signOutReason = null;
});

describe("Login", () => {
  it("OTP: validates the number, requests the code, verifies 6 digits", async () => {
    const calls = mockFetch((c) => (c.path === "/auth/otp/request" ? { status: 200, body: { sent: true, devCode: "123456" } } : { status: 404 }));
    render(<Login />);
    fireEvent.changeText(screen.getByPlaceholderText("98765 43210"), "98-765 43210 99");
    // digits only, max 10
    expect(screen.getByPlaceholderText("98765 43210").props.value).toBe("9876543210");
    await act(async () => fireEvent.press(screen.getByText("Send OTP")));
    expect(calls[0]).toMatchObject({ path: "/auth/otp/request", body: { phone: "9876543210" } });
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(screen.getByText(/Your code is 123456/)).toBeTruthy();
    expect(screen.getByText(/Resend code in 30s/)).toBeTruthy();

    fireEvent.changeText(screen.getByDisplayValue(""), "12a3456789");
    await act(async () => fireEvent.press(screen.getByText("Verify & sign in")));
    expect(mockAuth.loginWithOtp).toHaveBeenCalledWith("9876543210", "123456");
  });

  it("OTP: wrong code → error shown, can retry", async () => {
    mockFetch(() => ({ status: 200, body: { sent: true } }));
    mockAuth.loginWithOtp.mockRejectedValueOnce(new Error("Invalid or expired code"));
    render(<Login />);
    fireEvent.changeText(screen.getByPlaceholderText("98765 43210"), "9876543210");
    await act(async () => fireEvent.press(screen.getByText("Send OTP")));
    fireEvent.changeText(screen.getByDisplayValue(""), "000000");
    await act(async () => fireEvent.press(screen.getByText("Verify & sign in")));
    expect(screen.getByText("Invalid or expired code")).toBeTruthy();
  });

  it("password: invalid email rejected locally; valid → login; two-step challenge → code step", async () => {
    render(<Login />);
    fireEvent.press(screen.getByText("Use email & password instead"));
    fireEvent.changeText(screen.getByPlaceholderText("you@canteen.in"), "not-an-email");
    await act(async () => fireEvent.press(screen.getByText("Sign in")));
    expect(screen.getByText("Enter a valid email and password")).toBeTruthy();
    expect(mockAuth.loginWithPassword).not.toHaveBeenCalled();

    mockAuth.loginWithPassword.mockResolvedValueOnce({ mfaRequired: true, mfaToken: "mfa-1" });
    fireEvent.changeText(screen.getByPlaceholderText("you@canteen.in"), " cashier@canavo.local ");
    const pw = screen.UNSAFE_getAllByProps({ secureTextEntry: true })[0];
    fireEvent.changeText(pw, "Canavo@123");
    await act(async () => fireEvent.press(screen.getByText("Sign in")));
    expect(mockAuth.loginWithPassword).toHaveBeenCalledWith("cashier@canavo.local", "Canavo@123");
    expect(screen.getByText(/authenticator app/)).toBeTruthy();

    fireEvent.changeText(screen.getByDisplayValue(""), "654321");
    await act(async () => fireEvent.press(screen.getByText("Verify & sign in")));
    expect(mockAuth.verifyTwoFactor).toHaveBeenCalledWith("mfa-1", { code: "654321" });
  });

  it("suspended sign-out reason is shown; signed in → redirect to tabs", () => {
    mockAuth.signOutReason = "This business account is suspended";
    const { unmount } = render(<Login />);
    expect(screen.getByText("This business account is suspended")).toBeTruthy();
    unmount();
    mockAuth.status = "signedIn";
    render(<Login />);
    expect(screen.getByText("redirect:/(tabs)")).toBeTruthy();
  });
});

describe("Payment", () => {
  const order = (o: object = {}) => ({
    id: "ord-1", invoiceNumber: "INV-7", status: "OPEN", orderType: "TAKEAWAY", grandTotal: 18900, balance: 18900, payments: [], delivery: null, ...o,
  });

  beforeAll(async () => {
    await api.setTokens(tokens);
  });
  beforeEach(() => {
    mockParams.orderId = "ord-1";
  });

  it("cash: shows change for ₹200 tendered, records the payment, opens the receipt with the change", async () => {
    const calls = mockFetch((c) => {
      if (c.method === "GET" && c.path === "/orders/ord-1") return { status: 200, body: order() };
      if (c.path === "/orders/ord-1/payments") return { status: 200, body: { order: order({ status: "PAID" }), paid: true, balance: 0, change: 1100 } };
      return { status: 404, body: {} };
    });
    render(<Payment />);
    await waitFor(() => screen.getByText("Bill INV-7"));
    fireEvent.changeText(screen.getByPlaceholderText("189.00"), "200");
    expect(screen.getByText("Return change")).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText("Cash received")));
    const pay = calls.find((c) => c.path === "/orders/ord-1/payments")!;
    expect(pay.body).toEqual({ payments: [{ mode: "CASH", amount: 18900 }], tendered: 20000 });
    expect(pay.headers["Idempotency-Key"]).toMatch(/^m-/);
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: "/receipt/[orderId]", params: { orderId: "ord-1", change: "1100" } });
  });

  it("cash short → 'Short by' and the button is disabled", async () => {
    mockFetch(() => ({ status: 200, body: order() }));
    render(<Payment />);
    await waitFor(() => screen.getByText("Bill INV-7"));
    fireEvent.changeText(screen.getByPlaceholderText("189.00"), "100");
    expect(screen.getByText("Short by")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cash received/ }).props.accessibilityState.disabled).toBe(true);
  });

  it("payment rejected by the server → message shown, stays on the screen", async () => {
    mockFetch((c) =>
      c.path === "/orders/ord-1/payments" ? { status: 409, body: { error: "Order is paid" } } : { status: 200, body: order() },
    );
    render(<Payment />);
    await waitFor(() => screen.getByText("Bill INV-7"));
    await act(async () => fireEvent.press(screen.getByText("Cash received")));
    expect(screen.getByText("Order is paid")).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("already-paid order (paid on another device) → straight to the receipt", async () => {
    mockFetch(() => ({ status: 200, body: order({ status: "PAID", balance: 0 }) }));
    render(<Payment />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledTimes(1));
  });

  it("order fails to load (offline) → error with retry", async () => {
    mockFetch(() => "network");
    render(<Payment />);
    await waitFor(() => screen.getByText(/reach the server/));
  });
});
