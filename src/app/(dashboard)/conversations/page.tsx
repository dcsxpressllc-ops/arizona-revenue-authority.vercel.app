import { LegacyRedirect } from "@/components/legacy-redirect";

// Flat route to the first-membership sub-account inbox. The PWA manifest
// shortcut needs a static URL.
export default function LegacyConversations() {
  return <LegacyRedirect toSubPath="/conversations" />;
}
