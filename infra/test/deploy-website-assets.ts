import { readdirSync } from "node:fs";
import { join } from "node:path";

type AssetManifestFile = {
  displayName?: string;
  source: { path: string };
};

export type AssetManifest = {
  files: Record<string, AssetManifestFile>;
};

/** List file paths inside one CDK asset directory, relative to its root. */
export function listAssetRelativeFiles(cdkOutDir: string, assetSourcePath: string): string[] {
  const assetRoot = join(cdkOutDir, assetSourcePath);
  const files: string[] = [];

  function walk(currentDir: string, prefix: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(currentDir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walk(assetRoot, "");
  return files.sort();
}

export function deployWebsiteAssets(manifest: AssetManifest): AssetManifestFile[] {
  return Object.values(manifest.files)
    .filter((file) => file.displayName?.startsWith("DeployWebsite/Asset"))
    .sort((left, right) => left.displayName!.localeCompare(right.displayName!));
}
