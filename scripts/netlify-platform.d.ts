/** Build-time shape used by the unchanged finite gateway; no runtime binding or grant. */
declare const Netlify: {
  readonly env: {get(name: string): string | undefined};
};
