export function hasOnlyExpectedAudiences(
  audience: string | string[] | undefined,
  directoryAudience: string,
  userInfoAudience: string,
): boolean {
  const values = typeof audience === "string" ? [audience] : audience ?? [];
  const allowed = new Set([directoryAudience, userInfoAudience]);
  return values.includes(directoryAudience) && values.every((value) => allowed.has(value));
}
