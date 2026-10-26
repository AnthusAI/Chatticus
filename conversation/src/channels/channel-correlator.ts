import { createHmac, timingSafeEqual } from "node:crypto";

const TAG_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TAG_CHARACTERS = 10;
const TAG_SOURCE_BYTES = 7;

function base32Prefix(bytes: Uint8Array, characters: number): string {
	let accumulator = 0;
	let bitCount = 0;
	let encoded = "";
	for (const byte of bytes) {
		accumulator = (accumulator << 8) | byte;
		bitCount += 8;
		while (bitCount >= 5 && encoded.length < characters) {
			encoded += TAG_ALPHABET[(accumulator >>> (bitCount - 5)) & 31];
			bitCount -= 5;
		}
		accumulator &= (1 << bitCount) - 1;
	}
	return encoded;
}

/**
 * The short keyed hash that rides in a plus tag on a bot's address so a reply whose mail client dropped every threading
 * header can still be matched to its channel. It is a lookup hint only: it never authorizes a sender or a channel.
 *
 * @param secret The deployment's correlator secret.
 * @param tenantId The organization that owns the channel.
 * @param channelId The channel the tag identifies.
 * @returns Ten lowercase base 32 characters, valid in an email local part.
 */
export function channelCorrelatorTag(secret: string, tenantId: string, channelId: string): string {
	const digest = createHmac("sha256", secret).update(JSON.stringify([tenantId, channelId])).digest();
	return base32Prefix(digest.subarray(0, TAG_SOURCE_BYTES), TAG_CHARACTERS);
}

/**
 * Whether a tag read from an inbound address is the tag of this channel.
 *
 * @param secret The deployment's correlator secret.
 * @param tenantId The organization that owns the channel.
 * @param channelId The candidate channel.
 * @param tag The tag from the address, any case.
 * @returns True only for the exact tag, compared in constant time.
 */
export function correlatorTagMatchesChannel(secret: string, tenantId: string, channelId: string, tag: string): boolean {
	const expected = Buffer.from(channelCorrelatorTag(secret, tenantId, channelId));
	const offered = Buffer.from(tag.toLowerCase());
	return expected.length === offered.length && timingSafeEqual(expected, offered);
}
