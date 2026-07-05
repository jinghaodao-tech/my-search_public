# Logging and Error Observability

My Search App uses structured JSON logs through Pino so local, Docker, and CI logs can be searched and correlated by machines.

## Why Pino

Pino was added because it provides low-overhead JSON logging, built-in redaction support, and production-friendly log levels without changing the existing Express API surface.

## Request IDs

Every request receives an `X-Request-Id` response header. If the client sends `X-Request-Id`, the server reuses it; otherwise the server generates a UUID.

Request completion logs include:

| Field | Purpose |
|---|---|
| `requestId` | Correlates request, response, and error logs |
| `method` | HTTP method |
| `path` | Route path without query string |
| `statusCode` | Final HTTP status |
| `responseTimeMs` | Request duration |

## Error Response Format

Common API errors include a public error message and request ID:

```json
{
  "error": "Invalid request",
  "requestId": "..."
}
```

Validation errors also include sanitized validation details. Unexpected errors return `Internal server error` and never include stack traces in the HTTP response.

## Sensitive Data Handling

Logs must not include:

- API keys or `.env` values
- `Authorization` headers
- `Cookie` headers
- AI summary request text
- Card body content or private note text

The server logs request metadata, provider status, and sanitized error metadata instead of request bodies. Pino redaction is configured as a defense-in-depth layer for common secret fields.

## Local and Docker Log Checks

Local:

```bash
npm start
```

Docker:

```bash
docker compose up
```

Health check:

```bash
curl -i http://localhost:3000/healthz
```

Use the `X-Request-Id` response header to find matching request and error logs.

## Remaining Gaps

- Logs are written to stdout only; no external log aggregation is configured.
- Metrics and tracing are not yet exported to OpenTelemetry or Prometheus.
- Rate limit logs identify the bucket, but do not include per-client dashboards.
