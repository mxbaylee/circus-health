/** Personal packet choices are separate from accepted clinical evidence. */
export interface PacketRecordRef {
  kind: string;
  recordId: string;
}

export interface PacketSelection {
  /** Omitted means all kinds; an empty array selects no kinds. */
  kinds?: string[];
  from?: string | null;
  to?: string | null;
  /** Match any of these personally assigned tags; empty means unrestricted. */
  tags?: string[];
  include?: PacketRecordRef[];
  exclude?: PacketRecordRef[];
  /** Consent applies only to the exact private review item and its current scope. */
  approvals?: { key: string; fingerprint: string }[];
}

export interface PacketCandidate {
  record: PacketRecordRef;
  key: string;
  title: string;
  date: string | null;
  kind: string;
  tags: string[];
  alwaysWithhold: boolean;
  preferenceVersion: number;
  opaque: boolean;
}

export interface PacketReview {
  withheld: { key: string; title: string; reason: string }[];
  includedCount: number;
  emptyKinds: string[];
  opaqueItems: {
    key: string;
    title: string;
    fingerprint: string;
    blocked: boolean;
    reason: string;
    included: boolean;
    /** Private inspection only; never a packet companion download URL. */
    contentUrl?: string;
    text?: string;
    truncated?: boolean;
  }[];
  notice: string;
}
