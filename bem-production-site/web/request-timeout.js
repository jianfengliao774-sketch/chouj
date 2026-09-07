// Older wallet WebViews have AbortController but not AbortSignal.timeout().
// Keep the deadline active through response-body reads, and clear it on exit.
export async function withRequestTimeout(milliseconds, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try { return await run(controller.signal); }
  finally { clearTimeout(timer); }
}
