/**
 * Goes through the server route so `task.completed` fires and the activity is
 * logged. Throws on non-2xx so callers' try/catch + toast keeps working.
 */
export async function markTaskComplete(
  taskId: string,
  completed: boolean,
): Promise<void> {
  const res = await fetch(`/api/tasks/${taskId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't update task.");
  }
}
