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

/**
 * Invite issuance standing — RFC-002 §5.2 Genesis / Admin bypass.
 *
 * The mutual-contact gate (>= N contacts in `contacts.json`) is an anti-Sybil
 * control aimed at *ordinary peers*. Applied literally it deadlocks the very
 * first operator: a greenfield root identity has an empty contact book by
 * definition, so it could never mint the invite that populates that book.
 *
 * This module derives the presentation-layer standing shown in the Issue Invite
 * modal. It mirrors — and never widens — the enforcement performed by the
 * enclave in `invites::enforce_issuance_policy`:
 *
 *   | Signal                     | Enforced by              |
 *   |----------------------------|--------------------------|
 *   | `role === "admin"`         | Rust (already bypassed)  |
 *   | `vetting.is_genesis`       | Rust (vault lookup)      |
 *   | dev build                  | frontend only, advisory  |
 *
 * The anti-Sybil gate remains fully in force for every non-Genesis, non-Admin
 * issuer, and the moderation-flag gate is never waived at any tier.
 *
 * Note the dev bypass is a *display* affordance: the enclave is the enforcing
 * authority, so a dev build with no Genesis identity still surfaces the
 * backend's denial rather than pretending the mint succeeded.
 */

import type { InviteIssuanceStanding, IssuerStatus } from "../../lib/types";

/** Mirrors `invites::MIN_CONTACTS_THRESHOLD_FLOOR`. */
export const MIN_CONTACTS_FLOOR = 1;
/** Mirrors `invites::MAX_CONTACTS_THRESHOLD_CEILING`. */
export const MAX_CONTACTS_CEILING = 50;

/** Copy shown whenever the mutual-vetting gate is waived. */
export const BOOTSTRAP_NOTICE = "Operator bootstrap mode: mutual vetting bypassed";

export interface StandingInput {
  /** Issuer standing from `get_issuer_status`, or null while loading. */
  issuer: IssuerStatus | null;
  /** True in a `import.meta.env.DEV` build. */
  devMode: boolean;
  /** Contact-book size, used for the "root identity with no contacts" case. */
  contactCount: number;
}

/** Clamp a threshold into the range the enclave will accept. */
export function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return MIN_CONTACTS_FLOOR;
  return Math.min(MAX_CONTACTS_CEILING, Math.max(MIN_CONTACTS_FLOOR, Math.trunc(value)));
}

/**
 * Derive the issuance standing rendered by the Issue Invite modal.
 *
 * `bypassed` is the union of every waiver the enclave honours plus the
 * frontend-only dev affordance. `can_mint` additionally refuses a flagged
 * issuer, because moderation flags are never waived.
 */
export function deriveInviteStanding({
  issuer,
  devMode,
  contactCount,
}: StandingInput): InviteIssuanceStanding {
  const vetting = issuer?.vetting;
  const is_admin = issuer?.role === "admin";
  const is_genesis = vetting?.is_genesis === true;
  const is_flagged = (vetting?.active_moderation_flags ?? 0) > 0;

  // A root identity bootstrapping an empty contact book is the canonical
  // chicken-and-egg case: the gate is not merely unmet, it is unsatisfiable.
  const genesis_bootstrap = is_genesis && contactCount === 0;
  const bypassed = is_admin || is_genesis || devMode;

  let notice: string | null = null;
  if (is_admin) {
    notice = `${BOOTSTRAP_NOTICE} (Admin issuer — unlimited issuance, any tier).`;
  } else if (is_genesis) {
    notice =
      vetting?.bypass_reason ??
      (genesis_bootstrap
        ? `${BOOTSTRAP_NOTICE} (Genesis / Operator identity with an empty contact book).`
        : "Genesis / Operator identity — mutual-contact threshold not applied.");
  } else if (devMode) {
    notice = `${BOOTSTRAP_NOTICE} (frontend dev build — the enclave still enforces its own policy).`;
  }

  const tier_label = is_genesis ? "Genesis / Operator" : is_admin ? "Admin" : null;

  // Blocked reasons, evaluated only when no waiver is in force. Mirrors the
  // gate order in `invites::member_eligible`: flags, then age, then contacts.
  // With no standing data yet we fail CLOSED rather than assume the gate passes.
  let blocked_reason: string | null = null;
  if (!bypassed) {
    const required = vetting?.min_contacts_required ?? 5;
    if (!vetting) {
      blocked_reason = "Verifying issuer standing…";
    } else if (is_flagged) {
      blocked_reason = `Issuer carries ${vetting.active_moderation_flags} active moderation flag(s).`;
    } else if (!vetting.account_age_ok) {
      blocked_reason = `Account age ${vetting.account_age_days}d must exceed 14d before issuance.`;
    } else if (!vetting.contacts_ok) {
      blocked_reason = `Member vetting: need >= ${required} mutual contacts (have ${contactCount}).`;
    }
  } else if (is_flagged) {
    // A waiver never overrides a safety gate.
    blocked_reason = `Issuer carries ${vetting?.active_moderation_flags} active moderation flag(s).`;
  }

  return {
    bypassed,
    is_genesis,
    is_admin,
    dev_bypass: devMode && !is_admin && !is_genesis,
    tier_label: tier_label ?? (issuer?.role ?? "member"),
    notice,
    can_mint: blocked_reason === null,
    blocked_reason,
  };
}
