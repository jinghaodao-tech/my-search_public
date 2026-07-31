export type ApiError = Error & { status?: number; code?: string; requestId?: string };

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, init);
  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const data = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    const error = new Error(String(data.error ?? `Request failed (${response.status})`)) as ApiError;
    error.status = response.status;
    error.code = typeof data.code === 'string' ? data.code : 'request_failed';
    error.requestId = typeof data.requestId === 'string' ? data.requestId : response.headers.get('x-request-id') ?? '';
    throw error;
  }
  return payload as T;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

declare global { interface Window { typedApiClient?: typeof apiClient; } }
window.typedApiClient = apiClient;
