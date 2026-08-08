export function verifyPlatformBearer(header: string | undefined, configuredSecret: string | undefined): boolean {
  const configured = String(configuredSecret || "").trim();
  if (!configured || configured.length < 32 || configured === "undefined" || configured === "null") return false;
  const supplied = String(header || "");
  if (!/^Bearer\s+\S+$/.test(supplied)) return false;
  return supplied.slice(7).trim() === configured;
}
