// Minimal pictogram icons for dashboard tabs + actions.
// 16×16 viewBox, stroke-based, currentColor.

const s = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function IconOverview() {
  return (
    <svg {...s}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconPorts() {
  return (
    <svg {...s}>
      <circle cx="8" cy="5" r="2.5" />
      <circle cx="4.5" cy="11" r="2" />
      <circle cx="11.5" cy="11" r="2" />
      <line x1="8" y1="7.5" x2="5.5" y2="9" />
      <line x1="8" y1="7.5" x2="10.5" y2="9" />
    </svg>
  );
}

export function IconGroups() {
  return (
    <svg {...s}>
      <path d="M4 4 L12 8 L4 12 Z" />
    </svg>
  );
}

export function IconNetwork() {
  return (
    <svg {...s}>
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="3" ry="6" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <line x1="3.5" y1="5" x2="12.5" y2="5" />
      <line x1="3.5" y1="11" x2="12.5" y2="11" />
    </svg>
  );
}

/** Tunnel icon — mountain with hole (like a road tunnel) */
export function IconTunnel() {
  return (
    <svg {...s}>
      {/* Mountain outline */}
      <path d="M1 14 L5 4 L8 8 L11 4 L15 14" />
      {/* Tunnel hole (arch) */}
      <path d="M6 14 Q6 10 8 10 Q10 10 10 14" />
    </svg>
  );
}
