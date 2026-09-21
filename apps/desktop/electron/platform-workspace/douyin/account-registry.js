import { WebAccountRegistry } from '../account-registry.js';

export class DouyinAccountRegistry extends WebAccountRegistry {
  constructor(userDataPath) {
    super(userDataPath, { platformCode: 'douyin', partitionPrefix: 'douyin' });
  }
}
