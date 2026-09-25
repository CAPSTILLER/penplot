/**
 * Export helpers. Phones (iOS Safari especially) treat text/plain downloads as text and may
 * save them as ".txt" or open them in a tab, so G-code always goes out as application/octet-stream
 * with an explicit ".gcode" name.
 */
export const GCODE_MIME = 'application/octet-stream';

const STRIP_EXT = /\.(gcode|gco|g|nc|txt|text|svg|png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;

/** Safe `<name>.gcode` file name. Never ends in .txt / .text, never empty. */
export function gcodeFileName(name: string | null | undefined, fallback = 'penplot'): string {
  let base = String(name ?? '').trim();
  // strip any stack of known extensions: "draw.svg.txt" -> "draw"
  for (let i = 0; i < 4 && STRIP_EXT.test(base); i++) base = base.replace(STRIP_EXT, '');
  base = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 60)
    .replace(/[-_.]+$/g, '');
  if (!base || /^(text|txt)$/i.test(base)) base = fallback;
  return `${base}.gcode`;
}

/** A short, readable base name for a text design ("Pen Plot\ngearup.wtf" -> "pen-plot-gearup-wtf"). */
export function textSlug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return s ? `text-${s}` : 'text';
}

export function gcodeBlob(gcode: string): Blob {
  return new Blob([gcode], { type: GCODE_MIME });
}

export function gcodeFile(gcode: string, fileName: string): File {
  return new File([gcode], gcodeFileName(fileName), { type: GCODE_MIME });
}

/** Classic anchor download. The anchor must be in the DOM before click() for Safari/Firefox. */
export function downloadGcode(gcode: string, fileName: string, doc: Document = document): string {
  const name = gcodeFileName(fileName);
  const url = URL.createObjectURL(gcodeBlob(gcode));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
  return name;
}

/** True when the Web Share API can share files (iOS Safari 15+, Android Chrome). */
export function canShareGcode(nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  try {
    if (!nav || typeof nav.canShare !== 'function' || typeof nav.share !== 'function') return false;
    return nav.canShare({ files: [gcodeFile('; probe\n', 'probe.gcode')] });
  } catch {
    return false;
  }
}

/** Opens the share sheet with a real `*.gcode` File ("Save to Files" on iOS). Returns false if cancelled. */
export async function shareGcode(gcode: string, fileName: string, nav: Navigator = navigator): Promise<boolean> {
  const file = gcodeFile(gcode, fileName);
  try {
    await nav.share({ files: [file], title: file.name });
    return true;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return false;
    throw e;
  }
}
