/**
 * Removes what differs between two synthesizations of the same stack that
 * deploy nothing: CDK path metadata, the CDKMetadata analytics resource, and the
 * content hashes of bundled assets. What is left is the template CloudFormation
 * would act on.
 */
export function withoutBuildNoise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutBuildNoise);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "CDKMetadata") {
      continue;
    }
    if (key === "Metadata" && child !== null && typeof child === "object") {
      const { "aws:cdk:path": _path, ...rest } = child as Record<string, unknown>;
      if (Object.keys(rest).length > 0) {
        result[key] = withoutBuildNoise(rest);
      }
      continue;
    }
    result[key] = withoutBuildNoise(child);
  }
  return result;
}

/** The normalized template as the text kept in a committed fixture file. */
export function normalizedTemplateText(template: unknown): string {
  return JSON.stringify(withoutBuildNoise(template), null, 2).replace(/[0-9a-f]{64}/g, "ASSET_HASH") + "\n";
}
