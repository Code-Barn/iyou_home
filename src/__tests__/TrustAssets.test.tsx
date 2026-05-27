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
    derivation_index: 0,
    did: mockDid,
  },
  {
    profile_id: "alt",
    profile_name: "Alt Persona",
    derivation_index: 1,
    did: "did:key:zalt789",
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
      "Inspect Cryptographic Evidence Document",
    );
    fireEvent.click(inspectButton);

    await waitFor(() => {
      expect(
        screen.getByText("Cryptographic Evidence Document"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText('{"id":"vc-modal","data":"secret"}'),
    ).toBeInTheDocument();

    const closeButton = screen.getByText("Close");
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(
        screen.queryByText("Cryptographic Evidence Document"),
      ).not.toBeInTheDocument();
    });
  });
});
