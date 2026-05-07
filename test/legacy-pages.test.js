import { describe, expect, it } from 'vitest';

import { onRequest as blockPage } from '../functions/block-img.js';
import { onRequest as whitelistPage } from '../functions/whitelist-on.js';

describe('legacy removed public pages', () => {
  it('returns 404 for /block-img', async () => {
    const response = await blockPage();
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Not found');
  });

  it('returns 404 for /whitelist-on', async () => {
    const response = await whitelistPage();
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Not found');
  });
});
