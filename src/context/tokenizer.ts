import { get_encoding } from "tiktoken";

let enc: ReturnType<typeof get_encoding> | null = null;

function getEnc(): ReturnType<typeof get_encoding> {
  if (!enc) {
    enc = get_encoding("cl100k_base");
  }
  return enc;
}

export function countTokens(text: string): number {
  return getEnc().encode(text).length;
}

export function countTokensBatch(texts: string[]): number {
  const e = getEnc();
  let total = 0;
  for (const t of texts) {
    total += e.encode(t).length;
  }
  return total;
}
