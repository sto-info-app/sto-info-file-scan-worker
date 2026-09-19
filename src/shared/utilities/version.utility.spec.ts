import * as fs from 'node:fs';

import { getAppVersion } from './version.utility';

jest.mock('node:fs');

describe('version.utility', () => {
  it('should return version from package.json', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ version: '1.2.3' }),
    );

    expect(getAppVersion()).toBe('1.2.3');
  });
});
