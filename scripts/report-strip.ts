/**
 * Renders the felt-and-slip title strip used at the top of the documents
 * (docs/assets/*.svg). The load test calls it so that the strip of its report
 * always shows the numbers of the last run.
 */
export interface StripOptions {
  title: string;
  subtitle: string;
  slipTitle: string;
  rows: Array<[string, string]>;
  description: string;
}

export function renderStrip({ title, subtitle, slipTitle, rows, description }: StripOptions): string {
  const teeth = Array.from({ length: 16 }, () => '-11 8 -11 -8').join(' ');
  const body = rows
    .map(
      ([left, right], i) =>
        `    <text class="ink" x="822" y="${102 + i * 24}">${left}</text>\n    <text class="ink" x="1124" y="${102 + i * 24}" text-anchor="end">${right}</text>`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 220" width="1200" height="220" role="img" aria-labelledby="t d">
  <title id="t">${title}</title>
  <desc id="d">${description}</desc>
  <style>
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .ink { fill: #1E2622; font-size: 15px; }
  </style>
  <defs>
    <pattern id="felt" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#FFFFFF" stroke-opacity=".035" stroke-width="2"/>
    </pattern>
  </defs>
  <rect width="1200" height="220" rx="18" fill="#0E3B2E"/>
  <rect width="1200" height="220" rx="18" fill="url(#felt)"/>
  <rect x="12" y="12" width="1176" height="196" rx="12" fill="none" stroke="#C79A3A" stroke-opacity=".35"/>
  <g transform="translate(86 82)">
    <circle r="22" fill="#B8382E"/>
    <circle r="18" fill="none" stroke="#EDEFE6" stroke-width="5" stroke-dasharray="7 7"/>
    <circle r="11" fill="none" stroke="#EDEFE6" stroke-opacity=".8" stroke-width="1.5"/>
  </g>
  <g class="mono">
    <text x="64" y="148" font-size="40" font-weight="700" fill="#EDEFE6" letter-spacing="-1">${title}</text>
    <text x="66" y="180" font-size="16" fill="#B9C8BF">${subtitle}</text>
  </g>
  <path d="M796 40 H1148 V186 l${teeth} Z" fill="#000000" fill-opacity=".28" transform="translate(6 7)"/>
  <path d="M796 40 H1148 V186 l${teeth} Z" fill="#EDEFE6"/>
  <rect x="788" y="30" width="376" height="14" rx="7" fill="#072019"/>
  <g class="mono">
    <text x="822" y="66" font-size="15" font-weight="700" fill="#1E2622">${slipTitle}</text>
    <line x1="822" y1="76" x2="1124" y2="76" stroke="#1E2622" stroke-width="1.2" stroke-dasharray="3 4" opacity=".55"/>
${body}
  </g>
</svg>
`;
}
