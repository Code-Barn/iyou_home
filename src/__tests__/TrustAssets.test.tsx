/*
 * Copyright (C) 2026 David Byers dba Byers Brands
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import TrustAssets from "../components/TrustAssets";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
}));

import { invoke } from "@tauri-apps/api/core";

const mockDid = "did:key:zabc123def456";
const mockProfiles = [
  {
    profile_id: "primary",
    profile_name: "Primary Identity",
    // Index 1 is the canonical L1 Primary slot. (An index of 0 would make
    // `isAnchor()` true and silently drop this persona from the signable
    // set, which is not what an L1 persona looks like.)
    derivation_index: 1,
    did: mockDid,
    level: 1,
    is_system_reserved: false,
  },
  {
    profile_id: "alt",
    profile_name: "Alt Persona",
    derivation_index: 1,
    did: "did:key:zalt789",
    level: 2,
    is_system_reserved: false,
  },
];

function mockInvokeDefault() {
  (invoke as any).mockImplementation((cmd: string, _args?: any) => {
    if (cmd === "get_active_did") return Promise.resolve(mockDid);
    if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
    if (cmd === "get_credentials") return Promise.resolve([]);
    return Promise.reject(new Error(`unmocked: ${cmd}`));
  });
}

describe("TrustAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no credentials exist", async () => {
    mockInvokeDefault();
    render(<TrustAssets />);
    await waitFor(() => {
      expect(
        screen.getByText("No credentials stored for this persona."),
      ).toBeInTheDocument();
    });
  });

  it("renders credential cards with correct count and type names", async () => {
    const creds = [
      {
        vc_id: "vc-001",
        issuer_did: "did:key:zissuer1",
        subject_did: mockDid,
        credential_type: "UniversityDegree",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: '{"id":"vc-001"}',
      },
      {
        vc_id: "vc-002",
        issuer_did: "did:key:zissuer2",
        subject_did: mockDid,
        credential_type: "Membership",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: '{"id":"vc-002"}',
      },
    ];
    (invoke as any).mockImplementation((cmd: string, _args?: any) => {
      if (cmd === "get_active_did") return Promise.resolve(mockDid);
      if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
      if (cmd === "get_credentials") return Promise.resolve(creds);
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    });
    render(<TrustAssets />);
    await waitFor(() => {
      expect(screen.getByText("UniversityDegree")).toBeInTheDocument();
      expect(screen.getByText("Membership")).toBeInTheDocument();
    });
  });

  it.each([
    [1, "Tier 1: Social Peer Vouched"],
    [2, "Tier 2: Institutional Registry Vouched"],
    [3, "Tier 3: Secure Hardware Anchor Vouched"],
  ])(
    "maps fidelity_score=%i to correct tier badge",
    async (score, expectedLabel) => {
      const creds = [
        {
          vc_id: "vc-fid",
          issuer_did: "did:key:zissuer",
          subject_did: mockDid,
          credential_type: "Badge",
          fidelity_score: score,
          expiration_date: null,
          raw_payload: '{"id":"vc-fid"}',
        },
      ];
      (invoke as any).mockImplementation((cmd: string, _args?: any) => {
        if (cmd === "get_active_did") return Promise.resolve(mockDid);
        if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
        if (cmd === "get_credentials") return Promise.resolve(creds);
        return Promise.reject(new Error(`unmocked: ${cmd}`));
      });
      render(<TrustAssets />);
      await waitFor(() => {
        expect(screen.getByText(expectedLabel)).toBeInTheDocument();
      });
    },
  );

  it("shows no fidelity badge when fidelity_score is null", async () => {
    const creds = [
      {
        vc_id: "vc-null",
        issuer_did: "did:key:zissuer",
        subject_did: mockDid,
        credential_type: "Generic",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: '{"id":"vc-null"}',
      },
    ];
    (invoke as any).mockImplementation((cmd: string, _args?: any) => {
      if (cmd === "get_active_did") return Promise.resolve(mockDid);
      if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
      if (cmd === "get_credentials") return Promise.resolve(creds);
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    });
    render(<TrustAssets />);
    await waitFor(() => {
      expect(screen.getByText("Generic")).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Tier \d:/),
    ).not.toBeInTheDocument();
  });

  it("shows expired banner and grayscale class for past expiration_date", async () => {
    const pastDate = "2020-01-01T00:00:00Z";
    const creds = [
      {
        vc_id: "vc-exp",
        issuer_did: "did:key:zissuer",
        subject_did: mockDid,
        credential_type: "ExpiredCert",
        fidelity_score: null,
        expiration_date: pastDate,
        raw_payload: '{"id":"vc-exp"}',
      },
    ];
    (invoke as any).mockImplementation((cmd: string, _args?: any) => {
      if (cmd === "get_active_did") return Promise.resolve(mockDid);
      if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
      if (cmd === "get_credentials") return Promise.resolve(creds);
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    });
    render(<TrustAssets />);
    await waitFor(() => {
      expect(
        screen.getByText("[EXPIRED Lease - Re-verification Required]"),
      ).toBeInTheDocument();
      expect(screen.getByText("EXPIRED")).toBeInTheDocument();
    });
    const card = screen.getByText("ExpiredCert").closest(".credential-card");
    expect(card?.className).toContain("expired");
  });

  it("shows DID mismatch alert when subject_did does not match active profile", async () => {
    const creds = [
      {
        vc_id: "vc-mismatch",
        issuer_did: "did:key:zissuer",
        subject_did: "did:key:zsomebodyelse",
        credential_type: "MismatchCert",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: '{"id":"vc-mismatch"}',
      },
    ];
    (invoke as any).mockImplementation((cmd: string, _args?: any) => {
      if (cmd === "get_active_did") return Promise.resolve(mockDid);
      if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
      if (cmd === "get_credentials") return Promise.resolve(creds);
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    });
    render(<TrustAssets />);
    await waitFor(() => {
      expect(
        screen.getByText(/Identity Mismatch/),
      ).toBeInTheDocument();
    });
  });

  it("opens raw payload modal on Inspect click and closes on Close", async () => {
    const creds = [
      {
        vc_id: "vc-modal",
        issuer_did: "did:key:zissuer",
        subject_did: mockDid,
        credential_type: "ModalCert",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: '{"id":"vc-modal","data":"secret"}',
      },
    ];
    (invoke as any).mockImplementation((cmd: string, _args?: any) => {
      if (cmd === "get_active_did") return Promise.resolve(mockDid);
      if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
      if (cmd === "get_credentials") return Promise.resolve(creds);
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    });
    render(<TrustAssets />);
    await waitFor(() => {
      expect(screen.getByText("ModalCert")).toBeInTheDocument();
    });

    const inspectButton = screen.getByText(
      "View Raw Credential",
    );
    fireEvent.click(inspectButton);

    await waitFor(() => {
      expect(
        screen.getByText("Raw Credential"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText('{"id":"vc-modal","data":"secret"}'),
    ).toBeInTheDocument();

    const closeButton = screen.getByText("Close");
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(
        screen.queryByText("Raw Credential"),
      ).not.toBeInTheDocument();
    });
  });

  // ---------- EmailOwnershipCredential (iyou_idp) ----------

  const EMAIL_VC = {
    "@context": ["https://www.w3.org/2018/credentials/v1", "https://schema.org"],
    id: "urn:uuid:67140888-2921-4f9e-a892-75dca2e263d9",
    type: ["VerifiableCredential", "EmailOwnershipCredential"],
    issuer: "did:web:iyou.me",
    issuanceDate: "2026-10-02T20:30:00Z",
    credentialSubject: {
      id: mockDid,
      email: "developer@domain.com",
      email_type: "work",
      verified_at: "2026-10-02T20:30:00Z",
    },
    proof: { type: "RsaSignature2018" },
  };

  function mockEmailCreds(creds: any[]) {
    (invoke as any).mockImplementation((cmd: string, _args?: any) => {
      if (cmd === "get_active_did") return Promise.resolve(mockDid);
      if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
      if (cmd === "get_credentials") return Promise.resolve(creds);
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    });
  }

  it("renders Email Ownership card with verified email, category badge, issuer and timestamp", async () => {
    mockEmailCreds([
      {
        vc_id: "vc-email-1",
        issuer_did: "did:web:iyou.me",
        subject_did: mockDid,
        // Mirrors what add_credential_to_profile records: the first non-VC type.
        credential_type: "EmailOwnershipCredential",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: JSON.stringify(EMAIL_VC),
      },
    ]);
    render(<TrustAssets />);

    await waitFor(() => {
      expect(screen.getByText("Email Ownership")).toBeInTheDocument();
    });
    expect(screen.getByTestId("email-ownership-email")).toHaveTextContent(
      "developer@domain.com",
    );
    // email_type rendered as a category pill
    expect(screen.getByTestId("email-category-badge")).toHaveTextContent("work");
    expect(screen.getByText("did:web:iyou.me")).toBeInTheDocument();
    expect(screen.getByTestId("email-ownership-verified-at")).toHaveTextContent(
      "2026-10-02T20:30:00Z",
    );
  });

  it.each([
    ["personal", "personal"],
    ["work", "work"],
    ["alias", "alias"],
    ["unknown-value", "unknown"],
  ])(
    "maps email_type=%s to the %s badge",
    async (input, expectedLabel) => {
      mockEmailCreds([
        {
          vc_id: `vc-email-${input}`,
          issuer_did: "did:web:iyou.me",
          subject_did: mockDid,
          credential_type: "EmailOwnershipCredential",
          fidelity_score: null,
          expiration_date: null,
          raw_payload: JSON.stringify({
            ...EMAIL_VC,
            credentialSubject: {
              ...EMAIL_VC.credentialSubject,
              email_type: input,
            },
          }),
        },
      ]);
      render(<TrustAssets />);
      await waitFor(() => {
        expect(screen.getByTestId("email-category-badge")).toHaveTextContent(
          expectedLabel,
        );
      });
    },
  );

  it("detects EmailOwnershipCredential from raw payload when credential_type is generic VerifiableCredential", async () => {
    // The `save_credential` path records type[0], which is "VerifiableCredential".
    mockEmailCreds([
      {
        vc_id: "vc-email-savepath",
        issuer_did: "did:web:iyou.me",
        subject_did: mockDid,
        credential_type: "VerifiableCredential",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: JSON.stringify(EMAIL_VC),
      },
    ]);
    render(<TrustAssets />);
    await waitFor(() => {
      expect(screen.getByText("Email Ownership")).toBeInTheDocument();
    });
    expect(screen.getByTestId("email-ownership-email")).toHaveTextContent(
      "developer@domain.com",
    );
  });

  it("degrades gracefully when the email subject payload is malformed", async () => {
    mockEmailCreds([
      {
        vc_id: "vc-email-malformed",
        issuer_did: "did:web:iyou.me",
        subject_did: mockDid,
        credential_type: "EmailOwnershipCredential",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: "{not valid json",
      },
    ]);
    render(<TrustAssets />);
    // Falls back to the generic card rather than throwing.
    await waitFor(() => {
      expect(screen.getByText("EmailOwnershipCredential")).toBeInTheDocument();
    });
    expect(screen.queryByText("Email Ownership")).not.toBeInTheDocument();
    expect(screen.queryByTestId("email-ownership-email")).not.toBeInTheDocument();
  });

  it("renders Email Ownership card with placeholder fields when subject omits email and timestamp", async () => {
    mockEmailCreds([
      {
        vc_id: "vc-email-sparse",
        issuer_did: "did:web:iyou.me",
        subject_did: mockDid,
        credential_type: "EmailOwnershipCredential",
        fidelity_score: null,
        expiration_date: null,
        raw_payload: JSON.stringify({
          ...EMAIL_VC,
          credentialSubject: { id: mockDid },
        }),
      },
    ]);
    render(<TrustAssets />);
    await waitFor(() => {
      expect(screen.getByText("Email Ownership")).toBeInTheDocument();
    });
    expect(screen.getByTestId("email-ownership-email")).toHaveTextContent(
      "— not disclosed —",
    );
    expect(screen.getByTestId("email-category-badge")).toHaveTextContent("unknown");
  });

  it("imports a pasted EmailOwnershipCredential JSON-LD payload", async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    (invoke as any).mockImplementation((cmd: string, _args?: any) => {
      if (cmd === "get_active_did") return Promise.resolve(mockDid);
      if (cmd === "list_profiles") return Promise.resolve(mockProfiles);
      if (cmd === "get_credentials") return Promise.resolve([]);
      if (cmd === "import_verifiable_credential") return saveMock(_args);
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    });

    render(<TrustAssets />);
    // Wait for the credential fetch to settle so the persona selector has
    // already resolved the active profile before the modal captures its default.
    await waitFor(() => {
      expect(
        screen.getByText("No credentials stored for this persona."),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ Import Credential"));

    const textarea = await screen.findByPlaceholderText(
      /Paste raw W3C Verifiable Credential JSON payload/i,
    );
    fireEvent.change(textarea, {
      target: { value: JSON.stringify(EMAIL_VC) },
    });

    const submit = screen.getByText("Verify & Save to Vault");
    fireEvent.click(submit);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "primary",
          vcPayload: JSON.stringify(EMAIL_VC),
        }),
      );
    });
  });
});
