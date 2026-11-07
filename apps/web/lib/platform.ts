import { api } from "./api";

/**
 * Platform console requests never carry the outlet / business context: the
 * routes name the business explicitly, and a suspended business in the
 * headers would otherwise make the API refuse the request.
 */
const NO_CONTEXT = { outletId: null, businessId: null, support: false } as const;

export const platformApi = {
  get: <T>(path: string, query?: Record<string, string | undefined>) => api.get<T>(path, { ...NO_CONTEXT, query }),
  post: <T>(path: string, body?: unknown) => api.post<T>(path, body, NO_CONTEXT),
  patch: <T>(path: string, body?: unknown) => api.patch<T>(path, body, NO_CONTEXT),
};
