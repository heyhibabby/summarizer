/** Save a file. Uses a normal download link; callers may offer share() for iOS "Save to Files". */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFile(blob: Blob, filename: string): boolean {
  try {
    return typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [new File([blob], filename, { type: blob.type })] });
  } catch {
    return false;
  }
}

export async function shareFile(blob: Blob, filename: string): Promise<boolean> {
  try {
    await navigator.share({ files: [new File([blob], filename, { type: blob.type })], title: filename });
    return true;
  } catch {
    return false;
  }
}
