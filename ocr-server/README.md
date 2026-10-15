# BrokerDesk OCR server

Standalone CPU-first PaddleOCR service. It returns document text and evidence only; it never returns normalized insurance data.

1. Copy `.env.example` to `.env` and set a long `OCR_SERVICE_TOKEN`.
2. Run `docker compose up --build -d`.
3. Point BrokerDesk to the service with server-side `OCR_SERVER_URL` and the same `OCR_SERVICE_TOKEN`.

The default `ch` PP-OCR model recognizes Simplified Chinese and English mixed documents. `OCR_LANG` is configurable; use a PaddleOCR-supported Traditional Chinese model where required. The first container start downloads model files into the `paddle-models` volume. CPU is the default; a future GPU image can use the same API contract.

The queue defaults to one active job. Source and rendered files live only under the temporary job directory and are removed after success or failure. Startup also removes abandoned working directories older than `OCR_TEMP_TTL_SECONDS`.

Bind to a private office address only. Do not expose this service directly to the public internet.
