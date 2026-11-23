// Prepares the data job's summary for being written into the page at build time, so the first paint
// needs no extra request. Pool names and coinbase tags come from miners, so nothing in the text may be
// able to end the surrounding <script type="application/json"> block.

const ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };
const MAX_BYTES = 256 * 1024;

/** Returns JSON that is safe inside an HTML data block, or null when the input is not a usable summary. */
export function embeddableJson(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ESCAPES[char]);
}
