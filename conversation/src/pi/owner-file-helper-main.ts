import { runOwnerFileHelperFromStandardStreams } from "./owner-file-helper.ts";

process.exitCode = await runOwnerFileHelperFromStandardStreams();
