import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

/** True when synth/CI should skip Next.js bundling (no AWS credentials). */
export function shouldStubWebBundle(): boolean {
  return process.env.CHATTICUS_STUB_WEB_BUNDLE?.trim() === "1";
}

/** Minimal static site for synth and unit tests; never used on real deploy. */
export const stubWebsiteDeploySource = s3deploy.Source.data(
  "index.html",
  "<!DOCTYPE html><html><!-- chatticus stub web bundle --></html>",
);

/** Website deploy source selected by the CDK app entrypoint. */
export function websiteDeploySourceForApp():
  | s3deploy.ISource
  | undefined {
  return shouldStubWebBundle() ? stubWebsiteDeploySource : undefined;
}
