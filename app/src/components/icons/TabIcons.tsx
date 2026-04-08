// Minimal pictogram icons — 16×16 viewBox, stroke-based, currentColor.

const s = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const s12 = { ...s, width: 12, height: 12 };

// Dashboard tabs
export function IconOverview() {
  return <svg {...s}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>;
}
export function IconPorts() {
  return <svg {...s}><circle cx="8" cy="5" r="2.5" /><circle cx="4.5" cy="11" r="2" /><circle cx="11.5" cy="11" r="2" /><line x1="8" y1="7.5" x2="5.5" y2="9" /><line x1="8" y1="7.5" x2="10.5" y2="9" /></svg>;
}
export function IconGroups() {
  return <svg {...s}><path d="M4 4 L12 8 L4 12 Z" /></svg>;
}
export function IconNetwork() {
  return <svg {...s}><circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="3" ry="6" /><line x1="2" y1="8" x2="14" y2="8" /><line x1="3.5" y1="5" x2="12.5" y2="5" /><line x1="3.5" y1="11" x2="12.5" y2="11" /></svg>;
}
export function IconTunnel() {
  return <svg {...s}><path d="M1 14 L5 4 L8 8 L11 4 L15 14" /><path d="M6 14 Q6 10 8 10 Q10 10 10 14" /></svg>;
}

// Actions
export function IconPlay() {
  return <svg {...s12}><path d="M3 2 L11 6 L3 10 Z" /></svg>;
}
export function IconStop() {
  return <svg {...s12}><rect x="2" y="2" width="8" height="8" rx="1" /></svg>;
}
export function IconRestart() {
  return <svg {...s12}><path d="M10 2 A5 5 0 1 1 3 5" /><polyline points="10,2 10,5 7,2" /></svg>;
}
export function IconMenu() {
  return <svg {...s}><line x1="2" y1="4" x2="14" y2="4" /><line x1="2" y1="8" x2="14" y2="8" /><line x1="2" y1="12" x2="14" y2="12" /></svg>;
}
export function IconSettings() {
  return <svg {...s}><circle cx="8" cy="8" r="2.5" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M3.8 12.2l1-1M11.2 4.8l1-1" /></svg>;
}
export function IconReorder() {
  return <svg {...s12}><polyline points="3,4 6,1 9,4" /><line x1="6" y1="1" x2="6" y2="11" /><polyline points="3,8 6,11 9,8" /></svg>;
}
export function IconChevronUp() {
  return <svg {...s12}><polyline points="2,8 6,3 10,8" /></svg>;
}
export function IconChevronDown() {
  return <svg {...s12}><polyline points="2,4 6,9 10,4" /></svg>;
}
export function IconFolder() {
  return <svg {...s12}><path d="M1 3 L1 10 L11 10 L11 4.5 L6 4.5 L5 3 Z" /></svg>;
}
