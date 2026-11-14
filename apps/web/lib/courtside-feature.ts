// This is compiled into the browser bundle. Enable only after the worker,
// storage and T4 connection have been deployed and verified together.
export const courtsideEnabled = process.env.NEXT_PUBLIC_COURTSIDE_ENABLED === '1';
