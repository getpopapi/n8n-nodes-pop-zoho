# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-05-29

### Initial release

- **TD01 → Invoice**: maps a POP API payload to a Zoho Invoice (`POST /invoices`)
- **TD04 → Credit Note**: maps a POP API payload to a Zoho Credit Note (`POST /creditnotes`)
- **Security**: dual verification — HMAC-SHA256 (license key binding) + RSA-2048 JWT (POP API origin proof)
- **Contact resolution**: lookup by VAT/TRN → email → company name; auto-create if not found
- **Tax mapping**: resolves `order_items[].rate` to Zoho tax IDs via `GET /taxes`
- **Discount support**: percentage (`discount_percent`) and absolute (`discount_amount`, converted to %)
- **Dry run mode**: node-level flag skips all Zoho API calls and returns the mapped body
- **Sandbox mode**: POP API injects `_pop_dry_run: true` in sandbox requests (HMAC-signed)
- **Structured error responses**: all errors return `{ success: false, error_code, message }` — workflow never returns an empty body
- **UAE / GCC support**: `place_of_supply` parameter and VAT treatment derivation for Zoho Books
- **Multi-region**: EU, US, IN, AU, JP, CA Zoho data centers
- **OAuth2 credential**: region dropdown, pre-filled scopes for Zoho Invoice and Zoho Books
