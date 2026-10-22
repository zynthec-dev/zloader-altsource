export const MAX_IPA_BYTES = 200_000_000;
export const IPA_CHUNK_BYTES = 8_000_000;

// Read and upload one slice at a time; never base64-encode the whole IPA.
export async function uploadIPA(file, upload, progress = () => {}) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_IPA_BYTES) {
    throw new Error("Die IPA muss zwischen 1 Byte und 200 MB groß sein.");
  }
  const chunks = [];
  for (let offset = 0; offset < file.size; offset += IPA_CHUNK_BYTES) {
    const bytes = new Uint8Array(await file.slice(offset, offset + IPA_CHUNK_BYTES).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const result = await upload({ content: btoa(binary), encoding: "base64" });
    if (!/^[a-f0-9]{40}$/.test(result.sha || "")) throw new Error("GitHub hat den Upload nicht bestätigt. Bitte erneut versuchen.");
    chunks.push({ sha: result.sha, size: bytes.length });
    progress(Math.min(offset + bytes.length, file.size), file.size);
  }
  // Keep the existing metadata format for small files and older publishers.
  return chunks.length === 1 ? { sha: chunks[0].sha, size: file.size } : { chunks, size: file.size };
}
