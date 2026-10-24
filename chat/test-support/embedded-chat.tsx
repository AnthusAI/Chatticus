import "../styles.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRuntime, type ChatMessage } from "chatticus/chat-react";

function HostApplication() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "prompt", role: "user", content: [{ type: "text", text: "Check this draft" }] },
    { id: "reply", role: "assistant", content: [{ type: "text", text: "**Ready** to help. [Unsafe](javascript:alert(1))" }] },
  ]);
  const [sends, setSends] = useState(0);
  return <main>
    <output aria-label="Send count">{sends}</output>
    <ChatRuntime messages={messages} isRunning={false} isSendDisabled={false}
      onSendMessage={async (text) => {
        setSends((value) => value + 1);
        setMessages((current) => [...current,
          { id: "new-prompt", role: "user", content: [{ type: "text", text }] },
          { id: "new-answer", role: "assistant", content: [{ type: "text", text: "Host response received" }] },
        ]);
      }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<HostApplication />);
