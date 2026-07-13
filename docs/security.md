# Security model

## Trust boundaries

The anonymous browser is untrusted. Sites is the only browser-facing gateway; Railway verifies its signature independently. The API may validate and enqueue but cannot call OpenAI research or Apple writes. The private worker may research; only the deterministic publisher module may write to Apple, and it accepts a locked manifest ID rather than model output.

## Anonymous capabilities

Run creation returns a random capability in a URL fragment. Fragments are not sent in HTTP requests. The client exchanges it once, receives a scoped `HttpOnly`, `Secure`, `SameSite=Strict` cookie, and clears the fragment with `history.replaceState`. The database stores only peppered hashes. A session can mint a one-use transfer capability; deletion revokes all run capabilities.

Capabilities authorize one run, not identity. Daily HMAC-derived client buckets enforce abuse limits without storing raw IP addresses. Only trusted Sites/Cloudflare client-IP metadata may be used.

## Signed gateway

The Sites gateway signs key ID, timestamp, nonce, HTTP method, path, body hash, derived client bucket, and optional owner email. Railway allows a 60-second clock window and atomically stores each nonce until expiry. It rejects unknown methods/routes, forwarded headers, and bodies over 64 KB. Current and previous keys enable rotation.

## Research inputs

Adapters use fixed public HTTPS hosts, bounded pagination, response-size caps, and text truncation. DNS/IP checks and redirect validation block localhost, link-local, private networks, file URLs, and destination changes into blocked networks. Retrieved text is evidence, never instruction. Every claim must reference a stored source result; source roots prevent mirrored databases from masquerading as independent corroboration.

## Worker runtime isolation

Each durable handler receives a frozen, explicit repository facade. Research and matching handlers cannot read Apple authorization or invoke Apple publication methods; publication handlers cannot reserve OpenAI spend, save research evidence, or enqueue research work. The Apple-authorization handler can enqueue only publication jobs, and publication itself rechecks the owner pause, run cancellation state, and authorization generation before every Apple mutation batch.

Version one still co-locates these handlers in one private worker process. The facades reduce accidental and handler-level capability crossing, but they are not an operating-system security boundary: arbitrary code execution in that process could reach co-resident environment secrets. A higher-assurance deployment should split research and publication into separate services and secret sets while retaining the locked-manifest handoff.

## Secrets and data lifecycle

The owner OpenAI key exists only in Railway worker secrets. Apple developer credentials and the Apple-token encryption key exist in both Railway services: the API issues a short-lived developer token and encrypts the browser-returned user token, while only the private worker can decrypt that token and import the deterministic Apple write path. The Apple Music user token is stored as an AES-256-GCM envelope with a recorded key version. Secrets, capabilities, authorization headers, prompts, private keys, and tokens are redacted from logs.

Prompts, evidence, candidates, capability sessions, and detailed audit events expire after 90 days. Retained publication metadata is limited to Apple links, titles, manifest hashes, outcome counts, aggregate cost, and operational state. Visitor deletion removes Needle data but cannot remove a playlist already published in the owner's Apple account.
