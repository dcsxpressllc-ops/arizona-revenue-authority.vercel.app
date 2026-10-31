import { LogsView } from "@/components/logs/logs-view";

/** Read-only public API history: requests and webhook deliveries. Admin-only (enforced by the view). */
export default function LogsPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <LogsView />
    </div>
  );
}
