export async function request(path, init = {}) {
    const response = await fetch(path, init);
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
        const data = typeof payload === 'object' && payload !== null ? payload : {};
        const error = new Error(String(data.error ?? `Request failed (${response.status})`));
        error.status = response.status;
        error.code = typeof data.code === 'string' ? data.code : 'request_failed';
        error.requestId = typeof data.requestId === 'string' ? data.requestId : response.headers.get('x-request-id') ?? '';
        throw error;
    }
    return payload;
}
export const apiClient = {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    put: (path, body) => request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    del: (path) => request(path, { method: 'DELETE' }),
};
window.typedApiClient = apiClient;
