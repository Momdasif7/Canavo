import { API_URL } from "./config";
import { rewriteMediaUrl } from "./url";

/**
 * Phone-reachable URL for an uploaded image (menu item photo, outlet logo),
 * or null when there is none. See rewriteMediaUrl.
 */
export function mediaUrl(url: string | null | undefined): string | null {
  const u = url?.trim();
  return u ? rewriteMediaUrl(API_URL, u) : null;
}
