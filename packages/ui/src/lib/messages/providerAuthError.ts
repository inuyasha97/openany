export const PROVIDER_AUTH_FAILURE_MESSAGE = "Authentication failed for this provider. Please re-authenticate and retry.";

/**
 * The shape OMP reports when its model request cannot get through at all: the
 * connection keeps closing until the retry budget runs out. Reported from a
 * Windows install where the provider's credential existed but no longer worked,
 * which is why it names the network and the sign-in state without claiming
 * either is the cause.
 */
export const PROVIDER_TRANSPORT_FAILURE_MESSAGE = "OMP could not reach the model provider: it retried and the connection kept closing. Check this machine's network, VPN or proxy, and that the provider is still signed in under Settings → Providers.";

export const isLikelyProviderTransportFailure = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  const detail = value.toLowerCase();
  return detail.includes("retry budget exhausted") || detail.includes("socket connection was closed");
};

export const isLikelyProviderAuthFailure = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  const detail = value.toLowerCase().trim();
  if (!detail) {
    return false;
  }

  if (
    detail.includes("token refresh failed") ||
    detail.includes("unauthorized") ||
    detail.includes("invalid token") ||
    detail.includes("expired token")
  ) {
    return true;
  }

  const hasOauth = detail.includes("oauth");
  const hasOauthFailure =
    detail.includes("failed") || detail.includes("invalid") || detail.includes("expired");
  if (hasOauth && hasOauthFailure) {
    return true;
  }

  const has401 = /\b401\b/.test(detail);
  const hasAuthContext =
    detail.includes("auth") || detail.includes("token") || detail.includes("unauthorized");

  return has401 && hasAuthContext;
};
