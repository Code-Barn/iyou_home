# TODO — iyou_home (Tauri/Rust Local Enclave)

**Orchestrated from:** `omni_social` (central hub)
**Last synced:** 2026-07-13

---

## Layer 0 — Ecosystem Standardization

> iyou_home is a Tauri/Rust desktop app — no Django templates or ecosystem bar includes.

- [x] PKCE ingress verified (consumer of iyou_idp OIDC) — **Done 2026-07-13**

## Layer 2 — Security Hardening

- [ ] **[Critical] SEC-002 — Remove bundled Let's Encrypt private key:** `production.key` embedded via `env!()` in the Tauri binary. Replace with ephemeral, locally-generated self-signed certs trusted via local CA authority. Prevents extraction and local MITM on `wss://home.iyou.me:9001`.
- [ ] **[High] SEC-003 — did_rust submodule pinning:** Enforce commit-hash alignment between `iyou_home/libs/did_rust/` and `iyou_idp/crates/did_rust/` via CI. Prevents silent `serde_json` serialization drift.
- [ ] **[High] SEC-004 — Central SPOF mitigation:** Investigate offline-capable auth fallback when iyou_idp is unreachable.
- [ ] **[Medium] SEC-005 — Polling → Push migration:** Replace 1-second HTTP polling in verification loops with WebSocket or SSE push model. Reduces network chatter and challenge-replay attack window.
- [ ] **[Medium] SEC-006 — DNS hijack mitigation:** Evaluate certificate pinning or mTLS for `wss://home.iyou.me:9001` to prevent loopback traffic interception.
- [ ] **Ecosystem Doc Organization:** Standardize repo layout to match iyou_wun precedent — root: `AGENT.md`, `README.md`; `docs/`: `DEVELOPER_GUIDE.md`, `DESIGN_DOC.md`, `TODO.md`, `ecosystem_shared/`, `archive/`.

---
