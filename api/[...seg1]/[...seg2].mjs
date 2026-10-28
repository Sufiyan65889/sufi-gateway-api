// Depth 2 catch-all: Vercel matches one dynamic segment per file.
import entry from '../_entry.mjs';

export const fetch = entry.fetch;
export default entry;
