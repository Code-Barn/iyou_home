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

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import IssueInviteModal, {
  INVITE_QR_MODAL_HELPER_COPY,
} from "../components/invites/IssueInviteModal";
import type { InviteCapabilityToken } from "../lib/types";

describe("IssueInviteModal", () => {
  const SAMPLE_TOKEN: InviteCapabilityToken = {
    v: 1,
    issuer_did: "did:key:z6Mkprimary",
    satellite_id: "",
    nonce: "testnonce12345",
    max_uses: 1,
    uses_count: 0,
    tier: "member",
    created_at: 1700000000,
    expires_at: 1702592000,
    scope: ["join"],
    signature: "sig123",
  };

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <IssueInviteModal isOpen={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders token details, helper copy beneath QR code, and triggers copy callbacks", () => {
    const onCopyJson = vi.fn();
    const onCopyLink = vi.fn();
    const onClose = vi.fn();

    render(
      <IssueInviteModal
        isOpen={true}
        onClose={onClose}
        mintedToken={SAMPLE_TOKEN}
        qrUrl="data:image/png;base64,mockqr"
        inviteLink="https://iyou.me/airlock/?invite=sampleb64"
        onCopyJson={onCopyJson}
        onCopyLink={onCopyLink}
      />,
    );

    expect(screen.getByTestId("issue-invite-modal")).toBeInTheDocument();
    expect(screen.getByTestId("invite-token-json")).toHaveValue(JSON.stringify(SAMPLE_TOKEN));
    expect(screen.getByTestId("invite-qr-image")).toHaveAttribute("src", "data:image/png;base64,mockqr");
    expect(screen.getByTestId("invite-qr-hint")).toHaveTextContent(INVITE_QR_MODAL_HELPER_COPY);
    expect(screen.getByTestId("invite-qr-hint")).toHaveTextContent(
      "You can re-open this QR code or copy the airlock link at any time from your Invites table.",
    );

    fireEvent.click(screen.getByText("Copy Token JSON"));
    expect(onCopyJson).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Copy Invite Link"));
    expect(onCopyLink).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("invite-close-modal"));
    expect(onClose).toHaveBeenCalled();
  });
});
