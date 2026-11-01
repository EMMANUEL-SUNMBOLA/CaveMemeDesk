export async function fetchJson<T = unknown>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", ...opts.headers },
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status };
    }
    try {
      return { ok: true, data: JSON.parse(text) as T, status: res.status };
    } catch {
      return { ok: false, error: `invalid JSON: ${text.slice(0, 200)}`, status: res.status };
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
