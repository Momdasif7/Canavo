import { Alert } from "react-native";
import { errorMessage } from "../lib/api";
import { partnerUnavailable } from "./portal";

/** "Assign anyway?" dialog; resolves true when the manager confirms. */
function confirmForce(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Assign anyway?",
      `${message}\n\nThey'll get the order even though they're over the limit or not back at the outlet.`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Assign anyway", style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Run an assignment (PATCH /delivery/:id/assign or POST /orders with an
 * explicit partner). If the API answers 409 PARTNER_UNAVAILABLE with
 * `canForce` (manager / owner), ask "Assign anyway?" and retry with force.
 *
 * Resolves null when the user cancels. Any other error — including the 409
 * for a cashier, whose message already says why — is rethrown.
 */
export async function withForceConfirm<T>(attempt: (force: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await attempt(false);
  } catch (e) {
    const unavailable = partnerUnavailable(e);
    if (!unavailable?.canForce) throw e;
    if (!(await confirmForce(errorMessage(e)))) return null;
    return attempt(true);
  }
}
