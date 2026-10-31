"use client";

import { useState } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { AiSuiteChat } from "@/components/ai-suite/ai-suite-chat";
import { AiSuiteScopeBanner } from "@/components/ai-suite/ai-suite-scope-banner";
import { AiSuiteUsageCard } from "@/components/ai-suite/ai-suite-usage-card";

// Workspace Assistant: how-to answers and a few confirm-first actions, scoped
// to this sub-account.
export default function SubAccountAiSuitePage() {
  const { subAccountId, subAccount } = useSubAccount();
  // Scope banner shows on the empty state, hides once chatting, returns on New chat.
  const [chatActive, setChatActive] = useState(false);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4">
      {!chatActive && (
        <AiSuiteScopeBanner
          level="sub-account"
          subAccountName={subAccount?.name}
        />
      )}
      <AiSuiteUsageCard level="sub-account" subAccountId={subAccountId} />

      <div className="min-h-0 flex-1">
        <AiSuiteChat
          level="sub-account"
          subAccountId={subAccountId}
          onActiveChange={setChatActive}
        />
      </div>
    </div>
  );
}
