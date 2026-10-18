// A store module for load-stores-loader.test.ts, loaded through a real
// dynamic import() when no host loader is set. The specifier's last segment
// is the file name, not an export name, so loadStores takes the default.
export default class FixtureStore {
  constructor(config) {
    this.config = config;
  }
}
