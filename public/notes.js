// What each notification says, for the bell (app.js) and the email digest
// (digest.js), so both always say the same. A notification is one of
// /api/notifications' items (notifications() in worker.js). `kids` are the
// kids this person sees ({ id, name }); `kidId` is their own kid's, on a
// kid's own sign-in, which gets few words about their own art.
//
// Nothing here touches the page, so the Worker and the tests can run it.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const STICKER_WORDS = { heart: 'a heart', star: 'a gold star', wow: 'a wow', smile: 'a smiley', rainbow: 'a rainbow' };
// "a heart", "a heart and a gold star", "a heart, a wow and a gold star".
export const andList = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? ''));
const own = (s) => `${s}’s`;

// The words, as HTML with everything from the Worker escaped and the person
// in bold, or as plain text (`html` false).
export function noteWords(n, { kids = [], kidId = null } = {}, html = true) {
  const e = html ? esc : (s) => String(s ?? '');
  const kid = kids.find((k) => k.id === n.kid_id);
  const by = html ? `<b>${esc(n.by)}</b>` : String(n.by ?? '');
  const t = n.title ? e(n.title) : '';
  if (kidId != null && n.kid_id === kidId) {
    // To a kid, about their own art: few words, and the picture says which.
    const yours = t ? `your “${t}”` : 'your picture';
    if (n.kind === 'sticker') return `${by} gave ${yours} ${andList(n.stickers.map((s) => STICKER_WORDS[s]))}`;
    if (n.kind === 'art') return n.count === 1 ? `${by} put ${yours} on the fridge` : `${by} put ${n.count} of your pictures on the fridge`;
    return `${by} said`;
  }
  if (kidId != null) return `${by} said`;
  // The artist themselves isn't "Ada on Ada’s".
  const self = n.by_kid_id != null && n.by_kid_id === n.kid_id;
  const piece = self ? (t ? `“${t}”` : 'an untitled piece') : t ? `${e(own(kid?.name ?? ''))} “${t}”` : `${e(own(kid?.name ?? ''))} untitled piece`;
  if (n.kind === 'sticker') return `${by} gave ${piece} ${andList(n.stickers.map((s) => STICKER_WORDS[s]))}`;
  if (n.kind === 'art') {
    if (n.count > 1) return self ? `${by} put up ${n.count} new pieces` : `${by} put up ${n.count} new pieces by ${e(kid?.name ?? '')}`;
    return `${by} put up ${piece}`;
  }
  if (n.kind === 'reply') return `${by} replied on ${piece}`;
  return `${by} on ${piece}`;
}
