import { createRoot } from "react-dom/client";
import { EnabledWorkspace } from "../components/EnabledWorkspace";
import { setIdTokenSourceForTests } from "../lib/api-auth";

setIdTokenSourceForTests(async () => "workspace-layout-fixture");
window.fetch = async (input) => {
  const path = String(input);
  const body = path.endsWith("/bots") ? { bots: [] }
    : path.endsWith("/channels") ? { channels: [] }
      : path.endsWith("/tasks") ? { tasks: [] }
        : { computer_id: "computer-1", tenant_id: "tenant-1", stopped: true, policy: "prefer_local" };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};

createRoot(document.getElementById("root")!).render(
  <EnabledWorkspace
    activeOrg={{ tenantId: "tenant-1", userId: "user-1" }}
    organizations={[{ tenant_id: "tenant-1", name: "Layout acceptance", status: "enabled", role: "owner" }]}
    sessionEmail="member@example.test"
    onSignOut={async () => undefined}
    onReloadMembership={async () => undefined}
  />,
);
