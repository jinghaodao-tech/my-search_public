# Search Verification Policy

Search quality is measured with a versioned evaluation dataset and benchmark outputs. CI runs type checks, API tests, acceptance tests, E2E, quality evaluation, performance smoke tests, encoding checks, schema checks, and dependency audit.

`artifacts/` is generated output and must not contain secrets or source records. Threshold checks validate the generated quality report before publication.
