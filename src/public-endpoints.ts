export function normalizedPublicBasePath(publicBaseUrl: string): string {
  const pathname = new URL(publicBaseUrl).pathname.replace(/\/+$/, "");
  return pathname === "/" ? "" : pathname;
}

export function publicEndpointUrl(publicBaseUrl: string, suffix: string): URL {
  const url = new URL(publicBaseUrl);
  const basePath = normalizedPublicBasePath(publicBaseUrl);
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  url.pathname = `${basePath}${normalizedSuffix}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url;
}

export function authorizationMetadataPath(publicBaseUrl: string): string {
  return `/.well-known/oauth-authorization-server${normalizedPublicBasePath(publicBaseUrl)}`;
}
