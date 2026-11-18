// Types for pure.js, so that the tests can use the page's functions.

type Bytes = ArrayBuffer | Uint8Array;

export function toBase64(bytes: Bytes): string;
export function toBase64url(bytes: Bytes): string;
export function fromBase64url(text: string): Uint8Array;
export function toHex(bytes: Bytes): string;
export function requestIdFrom(search: string): string | null;
export function decisionSummary(
  cards: { id: string; hash: string | null }[],
  decisions: Map<string, string>,
): { accepted: { id: string; hash: string | null }[]; rejected: number; undecided: number; complete: boolean };
export function signLabel(count: number): string;
export function formatBytes(count: number): string;
export function hiddenCharacters(text: string): number;
export function assertionBody(credential: {
  rawId: Bytes;
  response: { authenticatorData: Bytes; clientDataJSON: Bytes; signature: Bytes };
}): { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };
export function signersLine(name: string, origin: string, rpId: string, credentialId: Bytes, publicKey: Bytes): string;
export function isSignerName(name: string): boolean;
export function flagsOf(authenticatorData: Bytes): {
  present: boolean;
  verified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  hasKey: boolean;
};
export function aaguidOf(authenticatorData: Bytes): string | null;
