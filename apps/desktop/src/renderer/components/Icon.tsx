import type { ReactElement } from 'react';

const paths = {
  home: 'm3 10 9-7 9 7v10H15v-7H9v7H3z',
  environments: 'M3 4h18v16H3z M3 9h18 M8 9v11',
  tasks: 'M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1',
  help: 'M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  terminal: 'm4 6 6 5-6 5 M13 18h7',
  plus: 'M12 4v16 M4 12h16',
  play: 'm8 4 12 8-12 8z',
  stop: 'M5 5h14v14H5z',
  close: 'm6 6 12 12 M6 18 18 6',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 14-2l1 2 M4 16l1 2a8 8 0 0 0 14-2',
} as const;

export function Icon({ name }: { readonly name: keyof typeof paths }): ReactElement {
  return (
    <svg
      className="icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
