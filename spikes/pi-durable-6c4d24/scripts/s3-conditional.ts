import { PutObjectCommand } from "@aws-sdk/client-s3";
import { writeResult } from "../src/report.ts";
import { createLocalS3, ensureBucket } from "../src/table.ts";

const s3 = createLocalS3();
const bucket = "pi-durable-spike";
await ensureBucket(s3, bucket);
const key = `probe/${Date.now()}.json`;
const put = async () => {
	try {
		await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "{}", IfNoneMatch: "*" }));
		return "written";
	} catch (error) {
		return `${(error as Error).name} (HTTP ${(error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode})`;
	}
};
const result = { first: await put(), second: await put() };
writeResult("s3-conditional.json", result);
console.log(JSON.stringify(result));
