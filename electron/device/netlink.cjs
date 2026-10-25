// Network link to a board: command framing over TCP, and the link key.

const crypto = require("node:crypto");

const { VND_MAGIC, HEADER_LEN } = require("./parser.cjs");

/**
 * META_BOARD_CHALLENGE: 16 fresh bytes, the only TLV of a keyed board's first frame.
 * The board streams only after a KEY0 answer within 10 s.
 */
const TAG_BOARD_CHALLENGE = 0x23;
const LINK_CHALLENGE_BYTES = 16;
/** HMAC'd ahead of the challenge. */
const LINK_CONTEXT = "N6LINK1";

/**
 * A frame header with meta_len 0 and payload_len the command length, then the command as
 * USB sends it. A board closes a connection that sends anything else.
 */
function frameHostCommand(command) {
  const frame = Buffer.alloc(HEADER_LEN + command.length);
  frame.writeUInt32LE(VND_MAGIC, 0);
  frame.writeUInt32LE(command.length, 12);
  frame.set(command, HEADER_LEN);
  return frame;
}

/** The challenge, if `meta` is a keyed board's challenge frame, else null. */
function findLinkChallenge(meta) {
  if (meta.length !== 3 + LINK_CHALLENGE_BYTES || meta[0] !== TAG_BOARD_CHALLENGE) return null;
  if ((meta[1] | (meta[2] << 8)) !== LINK_CHALLENGE_BYTES) return null;
  return Buffer.from(meta.subarray(3));
}

/** KEY0 then HMAC-SHA256(key, "N6LINK1" || challenge). */
function linkAnswer(key, challenge) {
  const mac = crypto.createHmac("sha256", key).update(LINK_CONTEXT).update(challenge).digest();
  return Buffer.concat([Buffer.from("KEY0", "latin1"), mac]);
}

module.exports = {
  frameHostCommand,
  findLinkChallenge,
  linkAnswer,
};
