import { setIdTokenSourceForTests } from "../lib/api-auth";
import { getTask, listTasks } from "../lib/api";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  action: "list" | "detail";
  apiOrigin: string;
  idToken: string;
  tenantId: string;
  userId: string;
  taskId?: string;
};

const sameOriginPrefix = "/api";
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  if (!target.startsWith(`${sameOriginPrefix}/`)) {
    throw new Error(`the web UI called ${target}, which is not a same-origin ${sameOriginPrefix} request`);
  }
  return realFetch(`${input.apiOrigin}${target.slice(sameOriginPrefix.length)}`, init);
}) as typeof fetch;
setIdTokenSourceForTests(async () => input.idToken);

async function main(): Promise<void> {
  const org = { tenantId: input.tenantId, userId: input.userId };
  try {
    if (input.action === "list") {
      const tasks = await listTasks(org);
      process.stdout.write(JSON.stringify({ titles: tasks.map((task) => task.title) }));
    } else {
      const task = await getTask(org, input.taskId ?? "");
      process.stdout.write(JSON.stringify({ title: task.title, status: task.status }));
    }
  } catch (caught) {
    process.stdout.write(JSON.stringify({ error: caught instanceof Error ? caught.message : String(caught) }));
  }
}

main();
