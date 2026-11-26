// How the fridge recognises a piece it has seen before, from any computer or
// phone: the source_hash scripts/fridge.py gives it. A picture, or a PDF of
// one page, is the SHA-256 of the file's bytes; each page of a PDF of several
// pages is the SHA-256 of "<file hash>:page <n>" (the script's page_hash and
// piece_id). tests/test_add_art.py checks both give the same for the same files.

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', data));

export const pageHash = (fileHash, number) => sha256(new TextEncoder().encode(`${fileHash}:page ${number}`));

// The source hash of page `number` (from 1) of a file with `count` pages.
export const pieceId = async (fileHash, number, count) => (count > 1 ? pageHash(fileHash, number) : fileHash);
