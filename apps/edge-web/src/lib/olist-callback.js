/** OLIST-T04: callback values live once in module memory, never browser storage. */
/** @type {{code:string,state:string,error:boolean}|null} */
let callback = null;

/** Remove OAuth query values before the shell starts requests or telemetry. */
export function captureOlistCallback() {
  const url = new URL(globalThis.location.href);
  if (url.pathname !== '/olist') return;
  if (!['code', 'state', 'error'].some((key) => url.searchParams.has(key)))
    return;
  const codes = url.searchParams.getAll('code');
  const states = url.searchParams.getAll('state');
  callback = {
    code: codes.length === 1 && codes[0].length <= 4096 ? codes[0] : '',
    state: states.length === 1 && states[0].length <= 512 ? states[0] : '',
    error: url.searchParams.has('error'),
  };
  globalThis.history.replaceState(globalThis.history.state, '', '/olist');
}

/** Consume once; refresh, route changes and replay cannot reuse a code. */
export function consumeOlistCallback() {
  const value = callback;
  callback = null;
  return value;
}
