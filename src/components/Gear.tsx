/** Build an SVG path for a gear centred on (0,0). */
export function gearPath(teeth: number, rOuter: number, rRoot: number, rHole: number): string {
  const step = (Math.PI * 2) / teeth;
  const pts: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    // tooth profile: root -> flank up -> top land -> flank down
    const seg = [
      [a, rRoot],
      [a + step * 0.12, rOuter],
      [a + step * 0.45, rOuter],
      [a + step * 0.57, rRoot],
    ];
    for (const [ang, r] of seg) pts.push(`${(Math.cos(ang) * r).toFixed(2)} ${(Math.sin(ang) * r).toFixed(2)}`);
  }
  const outer = `M${pts.join('L')}Z`;
  // hole drawn counter-clockwise with evenodd fill
  const hole = `M${rHole} 0A${rHole} ${rHole} 0 1 0 ${-rHole} 0A${rHole} ${rHole} 0 1 0 ${rHole} 0Z`;
  return `${outer}${hole}`;
}

interface GearProps {
  size?: number;
  teeth?: number;
  className?: string;
  rotation?: number;
  color?: string;
}

export function Gear({ size = 40, teeth = 12, className, rotation = 0, color = 'currentColor' }: GearProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="-50 -50 100 100"
      aria-hidden="true"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d={gearPath(teeth, 48, 39, 15)} fill={color} fillRule="evenodd" />
    </svg>
  );
}
