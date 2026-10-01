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
 * Invite issuance standing — RFC-002 §5.2 Genesis / Admin standing.
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
 *   | `role === "admin"`         | Rust (already exempt)    |
 *   | `vetting.is_genesis`       | Rust (vault lookup)      |
 *   | dev build                  | frontend only, advisory  |
 *
 * The same signal also waives the rolling 30-day issuance quota: a 3-token cap
 * deadlocks the operator out of its own onboarding run, the same way mutual
 * vetting would. `quotaStanding` reads the enclave's own
 * `issuance_quota_limit` so a raised or lifted ceiling is never hard-coded
 * here.
 *
 * The anti-Sybil gate remains fully in force for every non-Genesis, non-Admin
 * issuer, and the moderation-flag gate is never waived at any tier.
 *
 * Note the dev build is a *display* affordance: the enclave is the enforcing
 * authority, so a dev build with no Genesis identity still surfaces the
 * backend's denial rather than pretending the mint succeeded.
 *
 * All user-facing copy for these states lives here, in the badge and
 * requirements constants below. The UI must never describe a waived gate as a
 * "bypass": an operator's standing is a granted capability, and the enclave's
 * internal gate names are not product copy.
 */

import type { InviteIssuanceStanding, IssuerStatus } from "../../lib/types";

/** Mirrors `invites::MIN_CONTACTS_THRESHOLD_FLOOR`. */
export const MIN_CONTACTS_FLOOR = 1;
/** Mirrors `invites::MAX_CONTACTS_THRESHOLD_CEILING`. */
export const MAX_CONTACTS_CEILING = 50;
/** Mirrors `invites::MAX_USES_PER_TOKEN` (RFC-002 family-token bound). */
export const MEMBER_MAX_USES = 4;
/**
 * Mirrors `invites::MAX_USES_PER_TOKEN_GENESIS`. Genesis / Operator issuers mint
 * community-scale onboarding codes, so they are held to a higher ceiling than
 * the family-token bound of 4 applied to ordinary peers.
 */
export const GENESIS_MAX_USES = 100;
/** Mirrors `invites::MEMBER_MONTHLY_QUOTA` — the ordinary member issuance cap. */
export const MEMBER_MONTHLY_QUOTA = 3;
/** Mirrors `invites::MEMBER_ACCOUNT_AGE_DAYS`. */
export const MEMBER_MIN_ACCOUNT_AGE_DAYS = 14;

// ---------- Presentation labels ----------
//
// The modal is a production surface, so the standing of an uncapped issuer is
// presented as a capability badge rather than as a debugging banner. Nothing
// here describes *how* the gate is skipped ("bypassed", "not applied to you");
// the badge states what the account can do, and the tooltip explains why it
// legitimately can.

/** Badge shown to the vault's root / Genesis identity. */
export const GENESIS_BADGE_LABEL = "Genesis Cohort Sponsor";
export const GENESIS_BADGE_TOOLTIP =
  "Unlimited token creation enabled for root network seeding.";
/** Badge shown to an RFC-002 registry admin. */
export const ADMIN_BADGE_LABEL = "Network Administrator";
export const ADMIN_BADGE_TOOLTIP =
  "Registry-managed issuer — unrestricted creation across all tiers.";
/** Badge shown only in a `vite dev` build with no waived standing of its own. */
export const DEV_BADGE_LABEL = "Development Build";
export const DEV_BADGE_TOOLTIP =
  "Local build. The enclave still enforces its own issuance policy.";

export interface StandingBadge {
  label: string;
  tooltip: string;
  /** `data-testid` for the rendered pill. */
  testId: string;
}

/**
 * The badge describing an issuer's standing, or `null` for an ordinary member
 * whose standing is described by the plain requirements line instead.
 *
 * Genesis wins over Admin: the root identity is a sponsor first, and an Admin
 * registry role is an implementation detail of how it got there.
 */
export function standingBadge(standing: InviteIssuanceStanding): StandingBadge | null {
  if (standing.is_genesis) {
    return { label: GENESIS_BADGE_LABEL, tooltip: GENESIS_BADGE_TOOLTIP, testId: "invite-genesis-badge" };
  }
  if (standing.is_admin) {
    return { label: ADMIN_BADGE_LABEL, tooltip: ADMIN_BADGE_TOOLTIP, testId: "invite-admin-badge" };
  }
  // A dev build only claims the badge when nothing stronger applies, so it can
  // never be mistaken for a real standing.
  if (standing.dev_bypass) {
    return { label: DEV_BADGE_LABEL, tooltip: DEV_BADGE_TOOLTIP, testId: "invite-dev-badge" };
  }
  return null;
}

/**
 * The one-line eligibility summary for an ordinary member, e.g.
 * `"Requires account age ≥ 14d and ≥ 5 mutual contacts."`
 *
 * Values are read from the enclave rather than hard-coded, so an operator-tuned
 * contact threshold is reflected the moment it is applied.
 */
export function memberRequirements(issuer: IssuerStatus | null): string {
  const required = issuer?.vetting?.min_contacts_required ?? 5;
  return `Requires account age ≥ ${MEMBER_MIN_ACCOUNT_AGE_DAYS}d and ≥ ${required} mutual contacts.`;
}

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
 * Effective `max_uses` ceiling for the current issuer.
 *
 * Prefers the enclave's own `max_uses_limit` so the input bound can never
 * disagree with the enforcing predicate; falls back to the local mirror of
 * `invites::max_uses_limit_for` while standing is still loading, and stays at
 * the conservative 4 for a non-Genesis issuer if the field is absent.
 */
export function maxUsesLimit(standing: InviteIssuanceStanding, issuer: IssuerStatus | null): number {
  const reported = issuer?.max_uses_limit;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 1) {
    return Math.trunc(reported);
  }
  return standing.is_genesis || standing.is_admin ? GENESIS_MAX_USES : MEMBER_MAX_USES;
}

/**
 * Rolling-window quota standing, projected from the enclave's own
 * `issuance_quota_limit` so the pill can never assume a fixed ceiling of 3.
 *
 * `limit === null` means no cap is in force (Admin registry entries and the
 * Genesis / Operator identity) and `exhausted` is therefore always `false`.
 */
export interface QuotaStanding {
  used: number;
  /** `null` = unlimited. */
  limit: number | null;
  exhausted: boolean;
  /** Ready-to-render label for the quota pill. */
  label: string;
}

/**
 * Resolve the rolling 30-day issuance standing.
 *
 * The enclave is the authority: `issuance_quota_limit` wins whenever it is
 * present, and a `null` there means the account genuinely has no cap. Older
 * backends omit the field, so the fallback mirrors
 * `invites::issuance_quota_limit` locally — Genesis / Operator and Admin are
 * uncapped, and only an ordinary member falls back to the legacy numeric
 * `quota_limit` (0 = unlimited).
 */
export function quotaStanding(standing: InviteIssuanceStanding, issuer: IssuerStatus | null): QuotaStanding {
  // A junk count reads as 0 rather than NaN, so it can never be compared into a
  // spurious "exhausted".
  const raw = issuer?.quota_used_last_30d;
  const used = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;

  const reported = issuer?.issuance_quota_limit;
  let limit: number | null;
  if (typeof reported === "number" && Number.isFinite(reported)) {
    limit = reported >= 1 ? Math.trunc(reported) : null;
  } else if (standing.is_genesis || standing.is_admin) {
    limit = null;
  } else {
    const legacy = issuer?.quota_limit;
    limit =
      typeof legacy === "number" && Number.isFinite(legacy) && legacy >= 1
        ? Math.trunc(legacy)
        : MEMBER_MONTHLY_QUOTA;
  }

  // Only a capped issuer can be exhausted: with no limit in force the predicate
  // is vacuously satisfied, so the mint button stays enabled.
  const exhausted = limit !== null && used >= limit;
  const label =
    limit === null
      ? standing.is_genesis
        ? `${used} issued (Unlimited)`
        : "Unlimited"
      : `${used} / ${limit} used`;
  return { used, limit, exhausted, label };
}

/**
 * Derive the issuance standing rendered by the Issue Invite modal.
 *
 * `bypassed` is the union of every waiver the enclave honours plus the
 * frontend-only dev affordance. `can_mint` additionally refuses a flagged
 * issuer, because moderation flags are never waived.
 *
 * No free-text banner is produced here: `standingBadge` and
 * `memberRequirements` cover every case, and neither can describe a waiver as
 * a bypass — that framing is an implementation detail, not user-facing copy.
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
  const bypassed = is_admin || is_genesis || devMode;

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
      blocked_reason = `Account must be older than ${MEMBER_MIN_ACCOUNT_AGE_DAYS} days before it can issue invites (currently ${vetting.account_age_days}d).`;
    } else if (!vetting.contacts_ok) {
      blocked_reason = `Issuer needs ${required} mutual contacts before it can issue invites (currently ${contactCount}).`;
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
    can_mint: blocked_reason === null,
    blocked_reason,
  };
}
