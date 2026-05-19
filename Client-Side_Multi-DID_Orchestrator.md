# High-Level Design Summary: Client-Side Multi-DID Orchestrator & Vault Security Architecture

## 1. Architectural Evolution: Multi-Persona Orchestration

To support portable identities across the ecosystem without forcing users to create superfluous, disconnected accounts, `iyou\_home` will transition from a single-DID utility into a **Multi-DID Client-Side Orchestrator**.

- **The Tiered Identity Approach:** The architecture seamlessly supports both **Level 1 (Managed)** identities using `did:web` (resolved via HTTPS GET for frictionless onboarding) and **Level 2 (Sovereign)** identities using `did:key` (resolved fully off-chain via public keys mapped to localized seeds).

- **The Profile Registry Model:** The secure Rust backend (`vault.rs`) will manage an encrypted registry of distinct cryptographic personas (e.g., a "Citizen Identity" profile for formal processes and an "Anonymous Blogger" profile for social networking).

- **Preserving the Secure Enclave:** The React frontend remains a decoupled "Switchboard" utilizing Tauri IPC. It passes challenge strings to the Rust enclave alongside a selected profile identifier, ensuring raw private keys never touch the JavaScript environment.


## 2. The Interception Pattern & Local Service Mesh

Interaction between web-facing apps (`iyou\_wun`, `polly\_django`) and the local environment relies on a localized, cross-application event loop.

- **The Local WebSocket Bridge:** `iyou\_home` exposes a persistent background background worker on `ws://127.0.0.1:9001`.

- **Zero-Copy Authentication Handshake:** When an ecosystem web application requests a cryptographic signature, it pushes a random authentication challenge across the WebSocket instead of relying on manual clipboards.

- **UX Interception Context:** Upon receiving the websocket ping, the `iyou\_home` desktop tray application wakes up the React Switchboard interface. It presents a clear confirmation modal prompting the user to select *which* localized DID profile they wish to sign the challenge with before transmitting the verified signature back to the site.


## 3. Vault Security Layer: Hybrid Encryption Strategy

To establish a rigid security posture on the user's host filesystem, the local file mapping identity keys (`VaultStorage`) requires a defense-in-depth cryptography wrapper implemented inside Rust.

```
`+-------------------------------------------------------------+`

`|                      VaultStorage JSON                      |`

`+-------------------------------------------------------------+`

`                              |`

`                              v  (Encrypted via AEAD / XChaCha20-Poly1305)`

`+-------------------------------------------------------------+`

`|                  Data Encryption Key (DEK)                  |`

`+-------------------------------------------------------------+`

`                              |`

`                              v  (Wrapped / Encrypted)`

`+-------------------------------------------------------------+`

`|                  Key Encryption Key (KEK)                   |`

`+-------------------------------------------------------------+`

`           /                                       \\`

`          v                                         v`

`+------------------------------------+   +------------------------------------+`

`|    Option A: OS-Native Keyring     |   |     Option B: Master Password      |`

`|  (Keychain / Credential Manager)   |   |   (Argon2id Memory-Hard Derivation)|`

`+------------------------------------+   +------------------------------------+`
```

### Data Encryption Key (DEK) Isolation

The profile database JSON file is encrypted at rest using an authenticated symmetric encryption algorithm, such as **XChaCha20-Poly1305** or **AES-GCM-256**, driven natively by the `did\_rust` cryptographic kernel.

### Key Encryption Key (KEK) Lifecycle

The key required to unlock the DEK is dynamically compiled at runtime using a hybrid option strategy managed through user configuration:

- **Option A: OS-Native Integration (Frictionless UX):** The app utilizes platform-specific APIs (macOS Keychain, Windows Credential Manager, or Linux Secret Service API via the native Rust `keyring` library crate) to securely fetch or generate the KEK. This approach allows users to unlock their `iyou\_home` node instantly via OS-level authentication or biometric daemons.

- **Option B: Master Password Enforcement (Sovereign Privacy):** For environments lacking platform-specific credential keyrings, or for highly paranoid security setups, the KEK is derived explicitly from a user-generated Master Password. The phrase is passed through **Argon2id** (configured with memory-hard parameters) to guarantee resistance against off-chain brute-force side-channel threats.


## 4. Privacy-Preserving Governance Integration

This architectural pattern elegantly solves the Sybil resistance ("Vote Once") dilemma natively without centralized data aggregation.

- **Localized Verifiable Credentials (VCs):** When a user validates their local identity profile as a unique physical individual, an ecosystem credential issuer signs a VC confirming their uniqueness. This credential artifact is saved exclusively inside the user's local IPFS-backed configuration store.

- **Anonymized Audits:** When interacting with the `Polly` voting engine, the client orchestrator exposes the credential data strictly to prove human validation eligibility. The vote itself is recorded onto the append-only Merkle ledger as a standalone signed event cryptographic asset, fundamentally decoupling the user's public social data from their governance voting records.

