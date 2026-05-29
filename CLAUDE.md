# n8n-nodes-pop-zoho — Project Guide

## Purpose

Custom n8n node (npm package `n8n-nodes-pop-zoho`) that receives a POP API payload and creates the corresponding document in Zoho Invoice or Zoho Books.

Supported document types:
- `TD01` → Invoice (`POST /invoices`)
- `TD04` → Credit Note (`POST /creditnotes`)

## Repository Structure

```
n8n-nodes-pop-zoho/
├── credentials/
│   └── ZohoInvoiceOAuth2Api.credentials.ts   # OAuth2 credential — region dropdown, org ID, pre-filled scopes
├── nodes/
│   └── PopZohoInvoice/
│       ├── PopZohoInvoice.node.ts             # main node — all business logic lives here
│       └── pop-zoho-invoice.svg               # node icon
├── examples/
│   ├── payload.json                           # TD01 invoice (IT)
│   ├── payload-credit-note.json               # TD04 credit note
│   ├── payload-new-contact.json               # TD01 with unknown contact (triggers creation)
│   └── payload-tax-not-found.json             # TD01 with 15% rate not in Zoho (triggers tax_not_found)
├── package.json
└── tsconfig.json
```

## Operating Instructions

- Lead with the conclusion, keep answers brief
- Apply the smallest safe change first
- All text in code files must be in English (labels, descriptions, error messages, comments)
- Verify TypeScript compiles before calling anything done: `npx tsc --noEmit`
- Build for distribution: `npm run build` (outputs to `dist/`)

## Architecture

The node is a **regular n8n node** (not a trigger). It receives input from n8n's built-in Webhook node and outputs the Zoho API response. The recommended workflow in n8n is:

```
[Webhook node] → [POP → Zoho node] → [Respond to Webhook node]
```

- **Webhook node**: Authentication set to `None` — security is handled entirely by this node (HMAC + RSA JWT).
- **POP → Zoho node**: owns payload validation, HMAC verification, JWT verification, contact resolution, tax mapping, and Zoho API calls.
- **Respond to Webhook node**: forwards the node output as the HTTP response back to POP API.

The `execute()` method is wrapped in a top-level try-catch that converts any thrown error into a structured JSON response `{ success: false, error_code, message }` so the workflow never returns an empty body.

## Security Model

Every request from POP API carries two independent verification layers:

1. **HMAC-SHA256** — `X-POP-Signature` header, computed over `body + timestamp` using the license key. Verifies payload ownership.
2. **RSA JWT** — `_pop_jwt` field inside the payload, signed by POP API's RSA-2048 private key. Verifies the request originated from POP API servers.

Both checks are mandatory and cannot be disabled.

**Important**: PHP `json_encode` escapes `/` as `\/` by default. POP API must use `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE` when serializing the body for HMAC computation, to match JavaScript's `JSON.stringify` output.

## Core Logic in PopZohoInvoice.node.ts

| Function | Responsibility |
|----------|---------------|
| `validatePopPayload()` | checks required POP fields before any API call |
| `buildTaxMap()` | calls `GET /taxes` (or `GET /settings/taxes` for Books) once per execution, returns percentage→tax_id map |
| `resolveTaxId()` | looks up tax_id for a given rate; throws `tax_not_found` if missing |
| `resolveContact()` | lookup by VAT → email → name; creates contact if not found and allowed |
| `buildLineItems()` | maps `order_items[]` → Zoho `line_items[]`, handles discount_percent and discount_amount |
| `buildZohoInvoiceBody()` | assembles the full Zoho invoice/creditnote payload |
| `execute()` | orchestrates the above; top-level try-catch returns structured error JSON on failure |

## Credentials (ZohoInvoiceOAuth2Api)

The credential extends `oAuth2Api`. Key fields:

- `product` — dropdown: `Zoho Invoice` or `Zoho Books`; controls which scope string is pre-filled
- `region` — dropdown (EU/US/IN/AU/JP/CA); drives which `zohoapis.*` base URL is used
- `organizationId` — injected as `X-com-zoho-invoice-organizationid` on every Zoho API call
- `authUrl` / `accessTokenUrl` — user sets manually based on region (descriptions show the correct values)
- `scope` — string field, pre-filled with all required scopes for the selected product; do not change unless you know what you are doing

**Why `scope` is a string (not multiOptions):** n8n internally calls `(credentials.scope as string).split(' ')` — using an array type throws a TypeError at runtime.

## Zoho API Base URLs by Region

| Region | API base |
|--------|----------|
| EU | `https://www.zohoapis.eu/invoice/v3` |
| US | `https://www.zohoapis.com/invoice/v3` |
| IN | `https://www.zohoapis.in/invoice/v3` |
| AU | `https://www.zohoapis.com.au/invoice/v3` |
| JP | `https://www.zohoapis.jp/invoice/v3` |
| CA | `https://www.zohoapis.ca/invoice/v3` |

Defined in `ZOHO_URLS` in `credentials/ZohoInvoiceOAuth2Api.credentials.ts` and imported by the node.

## POP Payload Key Fields

The node reads from the standard POP API `data` object:

| POP path | Used for |
|----------|---------|
| `data.invoice_body.general_data.doc_type` | routing to `/invoices` (TD01) or `/creditnotes` (TD04) |
| `data.invoice_body.general_data.date` | invoice date |
| `data.invoice_body.general_data.currency` | currency_code |
| `data.invoice_body.general_data.invoice_number` | stored as reference (Zoho auto-assigns its own number) |
| `data.transferee_client.personal_data.*` | contact lookup/creation |
| `data.transferee_client.place.*` | billing_address on contact creation |
| `data.order_items[].description` | line_items[].name |
| `data.order_items[].unit_price` | line_items[].rate |
| `data.order_items[].quantity` | line_items[].quantity |
| `data.order_items[].rate` | tax lookup by percentage → line_items[].tax_id |
| `data.order_items[].discount_percent` | line_items[].discount (percentage) |
| `data.order_items[].discount_amount` | converted to percentage: `discount_amount / unit_price × 100` |
| `data.purchase_order_data.id` | reference_number (optional) |
| `data.connected_invoice_data.id` | reference_invoice_id (TD04 only) |
| `data.payment_data.terms_payment` | payment_terms in days (TP02 → deferred, configurable) |
| `_pop_dry_run` | injected by POP API in sandbox mode; skips all Zoho API calls |

Full payload examples: `examples/` folder.

## Node Parameters

| Parameter | Default | Effect |
|-----------|---------|--------|
| `popApiUrl` | `https://popapi.io` | Base URL for fetching the RSA public key |
| `popLicenseKey` | — | Used to verify the HMAC-SHA256 signature |
| `popRsaPublicKey` | — | Fetched via refresh button; used to verify the RSA JWT |
| `dryRun` | `false` | Skip all Zoho API calls regardless of `_pop_dry_run`; returns the mapped body |
| `contactMatchStrategy` | `vat_email_name` | search order for existing Zoho contact |
| `createContactIfMissing` | `true` | auto-create contact if not found |
| `invoiceStatus` | `draft` | created invoice status in Zoho |
| `sendEmail` | `false` | trigger Zoho's built-in invoice email to the customer |
| `placeOfSupply` | — | UAE e-invoicing emirate (leave empty for standard invoices) |
| `deferredPaymentDays` | `30` | Days granted for payment when terms_payment = TP02 |

## Error Codes Returned by the Node

| Code | Meaning |
|------|---------|
| `auth_error` | invalid HMAC signature, expired JWT, or missing security headers |
| `config_error` | License Key, RSA Public Key, or Organization ID not configured |
| `validation_error` | required POP field missing |
| `unsupported_doc_type` | doc_type is not TD01 or TD04 |
| `contact_not_found` | no match and `createContactIfMissing = false` |
| `contact_ambiguous` | multiple Zoho contacts match — resolve manually in Zoho |
| `contact_creation_failed` | Zoho refused contact creation |
| `tax_not_found` | rate% not configured in Zoho → Settings → Taxes |
| `zoho_api_error` | generic Zoho API error (details in n8n execution log) |
| `connector_error` | unexpected error not matching any of the above |

## Zoho Prerequisites (User Must Configure)

Before the node can create invoices:

1. **OAuth2 app** created in Zoho API Console with redirect URI pointing to the n8n OAuth callback
2. **Organization ID** retrieved from Zoho Invoice/Books → Settings → Organization Profile
3. **Tax rates** configured in Zoho → Settings → Taxes (one entry per % used in POP payloads)
4. **Currencies** enabled if using non-EUR invoices

## Development Commands

```bash
npx tsc --noEmit    # type check only
npm run build       # compile to dist/ + copy SVGs
npm run dev         # watch mode
```

## Installing in a Local n8n Instance

```bash
# link the local build directly into n8n
npm install /path/to/n8n-nodes-pop-zoho

# or after publishing to npm:
npm install n8n-nodes-pop-zoho
```

Requires n8n self-hosted or n8n Cloud Enterprise for custom nodes.

## Known Limitations (v1)

- **Contact update not implemented** — when an existing contact is found, its fields are not synced from the POP payload. Update manually in Zoho if needed.
- **Tax map not cached across runs** — one `GET /taxes` call per workflow execution.
- **Absolute discount rounding** — `discount_amount` is converted to a percentage (`amount / unit_price × 100`). Rounding may cause a tiny discrepancy (< 0.01%) on the Zoho total.
- **Document types** — only `TD01` (invoice) and `TD04` (credit note) supported in v1.
