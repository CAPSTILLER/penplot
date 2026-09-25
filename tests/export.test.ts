import { describe, expect, it } from 'vitest';
import { GCODE_MIME, canShareGcode, downloadGcode, gcodeBlob, gcodeFile, gcodeFileName, textSlug } from '../src/lib/exportFile';

describe('export file name and type', () => {
  it('always ends in .gcode and never in .txt/.text', () => {
    const cases = ['drawing.svg', 'photo.JPG', 'text', 'gcode.text', 'plot.gcode.txt', 'x.txt', '', null, undefined, '   ', 'Pen Plot / gearup.wtf', 'caf\u00e9 menu', '...', 'a'.repeat(200)];
    for (const c of cases) {
      const n = gcodeFileName(c as string);
      expect(n).toMatch(/^[a-z0-9_-]+\.gcode$/i);
      expect(n).not.toMatch(/\.(txt|text)$/i);
      expect(n.length).toBeLessThanOrEqual(67);
    }
    expect(gcodeFileName('drawing.svg')).toBe('drawing.gcode');
    expect(gcodeFileName('plot.gcode.txt')).toBe('plot.gcode');
    expect(gcodeFileName('text')).toBe('penplot.gcode');
    expect(gcodeFileName('penplot-pen-height-test')).toBe('penplot-pen-height-test.gcode');
    expect(textSlug('Pen Plot\ngearup.wtf')).toBe('text-pen-plot-gearup-wtf');
  });

  it('uses application/octet-stream, not text/plain', async () => {
    const b = gcodeBlob('; hello\nG28\n');
    expect(b.type).toBe(GCODE_MIME);
    expect(GCODE_MIME).toBe('application/octet-stream');
    const f = gcodeFile('; hello\nG28\n', 'my drawing.svg');
    expect(f.name).toBe('my-drawing.gcode');
    expect(f.type).toBe('application/octet-stream');
    expect(await f.text()).toBe('; hello\nG28\n');
  });

  it('download appends the anchor to the DOM before clicking', () => {
    const events: string[] = [];
    const anchor = {
      href: '', download: '', rel: '', style: {} as Record<string, string>,
      click() { events.push(`click:${body.children.includes(anchor)}:${anchor.download}`); },
      remove() { body.children = body.children.filter((c) => c !== anchor); },
    };
    const body = { children: [] as unknown[], appendChild(n: unknown) { this.children.push(n); events.push('append'); } };
    const doc = { createElement: () => anchor, body } as unknown as Document;
    const urls: Blob[] = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b: Blob) => { urls.push(b); return 'blob:x'; };
    try {
      const name = downloadGcode('; x\n', 'sample.svg', doc);
      expect(name).toBe('sample.gcode');
      expect(events).toEqual(['append', 'click:true:sample.gcode']);
      expect(urls[0].type).toBe('application/octet-stream');
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it('canShareGcode only when navigator.canShare accepts files', () => {
    expect(canShareGcode(undefined)).toBe(false);
    expect(canShareGcode({} as Navigator)).toBe(false);
    const seen: File[] = [];
    const nav = { share: async () => {}, canShare: (d: { files: File[] }) => { seen.push(...d.files); return true; } } as unknown as Navigator;
    expect(canShareGcode(nav)).toBe(true);
    expect(seen[0].name).toMatch(/\.gcode$/);
    expect(seen[0].type).toBe('application/octet-stream');
    expect(canShareGcode({ share: async () => {}, canShare: () => false } as unknown as Navigator)).toBe(false);
  });
});
