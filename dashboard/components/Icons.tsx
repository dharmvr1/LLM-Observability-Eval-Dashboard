// Small inline icons (stroke style). Status is never shown by color alone: every status color comes with an icon and a label.
type P = { size?: number };
const base = (size: number) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export const CheckCircle = ({ size = 16 }: P) => (<svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16 9.8" /></svg>);
export const AlertTriangle = ({ size = 16 }: P) => (<svg {...base(size)}><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><path d="M12 10v4.2M12 17.2v.1" /></svg>);
export const XCircle = ({ size = 16 }: P) => (<svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>);
export const MinusCircle = ({ size = 16 }: P) => (<svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M8.5 12h7" /></svg>);
export const ArrowUp = ({ size = 14 }: P) => (<svg {...base(size)}><path d="M12 19V5M6 11l6-6 6 6" /></svg>);
export const ArrowDown = ({ size = 14 }: P) => (<svg {...base(size)}><path d="M12 5v14M6 13l6 6 6-6" /></svg>);
export const Minus = ({ size = 14 }: P) => (<svg {...base(size)}><path d="M6 12h12" /></svg>);
export const Sun = ({ size = 17 }: P) => (<svg {...base(size)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
export const Moon = ({ size = 17 }: P) => (<svg {...base(size)}><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" /></svg>);
export const Pulse = ({ size = 16 }: P) => (<svg {...base(size)}><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></svg>);
export const Inbox = ({ size = 22 }: P) => (<svg {...base(size)}><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5.5 5h13L21 13v6H3v-6l2.5-8Z" /></svg>);
